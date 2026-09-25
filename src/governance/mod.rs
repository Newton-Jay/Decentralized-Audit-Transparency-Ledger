//! Multi-signature governance with flexible threshold policies.
//!
//! This module implements the policy engine, proposal lifecycle, veto rights,
//! and emergency procedures for contract multi-signature governance.

use std::collections::{BTreeMap, BTreeSet};

/// A signer authorized to participate in governance.
pub type SignerId = String;

/// Flexible threshold policy for a governance proposal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThresholdPolicy {
    /// The set of signers eligible to approve.
    pub signers: BTreeSet<SignerId>,
    /// Minimum number of approvals required to execute.
    pub approval_threshold: usize,
    /// Minimum number of vetoes that blocks a proposal.
    pub veto_threshold: usize,
    /// Optional time lock (in seconds) between approval and execution.
    pub time_lock_secs: u64,
    /// Signers permitted to invoke emergency procedures.
    pub emergency_signers: BTreeSet<SignerId>,
}

impl ThresholdPolicy {
    /// Creates a new policy, validating that thresholds are satisfiable.
    pub fn new(
        signers: BTreeSet<SignerId>,
        approval_threshold: usize,
        veto_threshold: usize,
        time_lock_secs: u64,
        emergency_signers: BTreeSet<SignerId>,
    ) -> Result<Self, PolicyError> {
        if approval_threshold == 0 || approval_threshold > signers.len() {
            return Err(PolicyError::InvalidApprovalThreshold);
        }
        if veto_threshold == 0 || veto_threshold > signers.len() {
            return Err(PolicyError::InvalidVetoThreshold);
        }
        if !emergency_signers.is_subset(&signers) {
            return Err(PolicyError::EmergencySignerNotAuthorized);
        }
        Ok(Self {
            signers,
            approval_threshold,
            veto_threshold,
            time_lock_secs,
            emergency_signers,
        })
    }

    /// Evaluates whether the given approvals/vetoes satisfy the policy.
    pub fn evaluate(&self, approvals: &BTreeSet<SignerId>, vetoes: &BTreeSet<SignerId>) -> PolicyOutcome {
        if vetoes.len() >= self.veto_threshold {
            return PolicyOutcome::Vetoed;
        }
        if approvals.len() >= self.approval_threshold {
            return PolicyOutcome::Approved;
        }
        PolicyOutcome::Pending
    }
}

/// Result of evaluating a policy against current votes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyOutcome {
    Pending,
    Approved,
    Vetoed,
}

/// Errors raised by the policy engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyError {
    InvalidApprovalThreshold,
    InvalidVetoThreshold,
    EmergencySignerNotAuthorized,
    UnknownSigner,
    ProposalNotPending,
    TimeLockNotElapsed,
    NotAuthorized,
}

/// Lifecycle state of a proposal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProposalState {
    Pending,
    Approved,
    Executed,
    Expired,
    Cancelled,
    Vetoed,
}

/// A governance proposal with a time-locked lifecycle.
#[derive(Debug, Clone)]
pub struct Proposal {
    pub id: u64,
    pub policy: ThresholdPolicy,
    pub created_at: u64,
    pub expires_at: u64,
    pub approved_at: Option<u64>,
    pub state: ProposalState,
    pub approvals: BTreeSet<SignerId>,
    pub vetoes: BTreeSet<SignerId>,
    pub emergency: bool,
}

/// Audit trail entry recording a governance action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditEntry {
    pub proposal_id: u64,
    pub actor: SignerId,
    pub action: AuditAction,
    pub timestamp: u64,
}

/// Actions recorded in the audit trail.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditAction {
    Created,
    Approved,
    Vetoed,
    Executed,
    Expired,
    Cancelled,
    EmergencyExecuted,
}

/// The governance engine managing proposals and the audit trail.
#[derive(Debug, Default)]
pub struct GovernanceEngine {
    next_id: u64,
    proposals: BTreeMap<u64, Proposal>,
    audit: Vec<AuditEntry>,
}

impl GovernanceEngine {
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a new time-locked proposal.
    pub fn create_proposal(
        &mut self,
        policy: ThresholdPolicy,
        creator: SignerId,
        now: u64,
        ttl_secs: u64,
    ) -> Result<u64, PolicyError> {
        if !policy.signers.contains(&creator) {
            return Err(PolicyError::UnknownSigner);
        }
        let id = self.next_id;
        self.next_id += 1;
        let proposal = Proposal {
            id,
            policy,
            created_at: now,
            expires_at: now.saturating_add(ttl_secs),
            approved_at: None,
            state: ProposalState::Pending,
            approvals: BTreeSet::new(),
            vetoes: BTreeSet::new(),
            emergency: false,
        };
        self.proposals.insert(id, proposal);
        self.record(id, creator, AuditAction::Created, now);
        Ok(id)
    }

    /// Records an approval from an authorized signer.
    pub fn approve(&mut self, id: u64, signer: SignerId, now: u64) -> Result<PolicyOutcome, PolicyError> {
        let proposal = self.proposals.get_mut(&id).ok_or(PolicyError::ProposalNotPending)?;
        if proposal.state != ProposalState::Pending {
            return Err(PolicyError::ProposalNotPending);
        }
        if !proposal.policy.signers.contains(&signer) {
            return Err(PolicyError::UnknownSigner);
        }
        proposal.approvals.insert(signer.clone());
        self.record(id, signer, AuditAction::Approved, now);
        let outcome = proposal.policy.evaluate(&proposal.approvals, &proposal.vetoes);
        if outcome == PolicyOutcome::Approved {
            proposal.state = ProposalState::Approved;
            proposal.approved_at = Some(now);
        }
        Ok(outcome)
    }

    /// Records a veto from an authorized signer, blocking the proposal.
    pub fn veto(&mut self, id: u64, signer: SignerId, now: u64) -> Result<PolicyOutcome, PolicyError> {
        let proposal = self.proposals.get_mut(&id).ok_or(PolicyError::ProposalNotPending)?;
        if proposal.state != ProposalState::Pending {
            return Err(PolicyError::ProposalNotPending);
        }
        if !proposal.policy.signers.contains(&signer) {
            return Err(PolicyError::UnknownSigner);
        }
        proposal.vetoes.insert(signer.clone());
        self.record(id, signer, AuditAction::Vetoed, now);
        let outcome = proposal.policy.evaluate(&proposal.approvals, &proposal.vetoes);
        if outcome == PolicyOutcome::Vetoed {
            proposal.state = ProposalState::Vetoed;
        }
        Ok(outcome)
    }

    /// Executes an approved proposal once its time lock has elapsed.
    pub fn execute(&mut self, id: u64, signer: SignerId, now: u64) -> Result<(), PolicyError> {
        let proposal = self.proposals.get_mut(&id).ok_or(PolicyError::ProposalNotPending)?;
        if proposal.state != ProposalState::Approved {
            return Err(PolicyError::ProposalNotPending);
        }
        if !proposal.policy.signers.contains(&signer) {
            return Err(PolicyError::UnknownSigner);
        }
        let approved_at = proposal.approved_at.ok_or(PolicyError::ProposalNotPending)?;
        if now < approved_at.saturating_add(proposal.policy.time_lock_secs) {
            return Err(PolicyError::TimeLockNotElapsed);
        }
        proposal.state = ProposalState::Executed;
        self.record(id, signer, AuditAction::Executed, now);
        Ok(())
    }

    /// Emergency execution bypassing the normal threshold and time lock.
    pub fn emergency_execute(&mut self, id: u64, signer: SignerId, now: u64) -> Result<(), PolicyError> {
        let proposal = self.proposals.get_mut(&id).ok_or(PolicyError::ProposalNotPending)?;
        if !proposal.policy.emergency_signers.contains(&signer) {
            return Err(PolicyError::NotAuthorized);
        }
        if matches!(proposal.state, ProposalState::Executed | ProposalState::Cancelled | ProposalState::Expired) {
            return Err(PolicyError::ProposalNotPending);
        }
        proposal.state = ProposalState::Executed;
        proposal.emergency = true;
        self.record(id, signer, AuditAction::EmergencyExecuted, now);
        Ok(())
    }

    /// Cancels a pending proposal.
    pub fn cancel(&mut self, id: u64, signer: SignerId, now: u64) -> Result<(), PolicyError> {
        let proposal = self.proposals.get_mut(&id).ok_or(PolicyError::ProposalNotPending)?;
        if proposal.state != ProposalState::Pending {
            return Err(PolicyError::ProposalNotPending);
        }
        if !proposal.policy.signers.contains(&signer) {
            return Err(PolicyError::UnknownSigner);
        }
        proposal.state = ProposalState::Cancelled;
        self.record(id, signer, AuditAction::Cancelled, now);
        Ok(())
    }

    /// Expires a proposal whose TTL has elapsed.
    pub fn expire(&mut self, id: u64, now: u64) -> Result<(), PolicyError> {
        let proposal = self.proposals.get_mut(&id).ok_or(PolicyError::ProposalNotPending)?;
        if proposal.state != ProposalState::Pending {
            return Err(PolicyError::ProposalNotPending);
        }
        if now < proposal.expires_at {
            return Err(PolicyError::TimeLockNotElapsed);
        }
        proposal.state = ProposalState::Expired;
        self.record(id, String::new(), AuditAction::Expired, now);
        Ok(())
    }

    /// Returns a proposal by id.
    pub fn proposal(&self, id: u64) -> Option<&Proposal> {
        self.proposals.get(&id)
    }

    /// Returns the full audit trail.
    pub fn audit_trail(&self) -> &[AuditEntry] {
        &self.audit
    }

    fn record(&mut self, proposal_id: u64, actor: SignerId, action: AuditAction, timestamp: u64) {
        self.audit.push(AuditEntry {
            proposal_id,
            actor,
            action,
            timestamp,
        });
    }
}
