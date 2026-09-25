//! Multi-signature governance policy engine.
//!
//! Provides flexible threshold policies, time-locked proposal lifecycles,
//! veto rights, and emergency procedures for contract multi-sig governance.

use std::collections::{BTreeMap, BTreeSet};

/// A single signer participating in governance.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SignerId(pub String);

/// Flexible threshold policy describing how approvals are evaluated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThresholdPolicy {
    /// The set of authorized signers.
    pub signers: BTreeSet<SignerId>,
    /// Minimum number of approvals required to pass.
    pub approval_threshold: usize,
    /// Optional per-signer weights (defaults to 1 when absent).
    pub weights: BTreeMap<SignerId, u64>,
    /// Minimum total weight required to pass (0 disables weight checks).
    pub weight_threshold: u64,
    /// Signers granted veto rights.
    pub veto_signers: BTreeSet<SignerId>,
    /// Signers allowed to trigger emergency execution.
    pub emergency_signers: BTreeSet<SignerId>,
    /// Time-lock (in seconds) before an approved proposal may execute.
    pub time_lock_secs: u64,
    /// Maximum lifetime (in seconds) of a proposal before it expires.
    pub proposal_ttl_secs: u64,
}

impl ThresholdPolicy {
    /// Creates a policy with a simple count-based threshold and no weights.
    pub fn new(signers: impl IntoIterator<Item = SignerId>, approval_threshold: usize) -> Self {
        Self {
            signers: signers.into_iter().collect(),
            approval_threshold,
            weights: BTreeMap::new(),
            weight_threshold: 0,
            veto_signers: BTreeSet::new(),
            emergency_signers: BTreeSet::new(),
            time_lock_secs: 0,
            proposal_ttl_secs: 0,
        }
    }

    /// Returns the weight of a signer (defaults to 1).
    pub fn weight_of(&self, signer: &SignerId) -> u64 {
        self.weights.get(signer).copied().unwrap_or(1)
    }

    /// Evaluates whether the collected approvals satisfy the policy.
    pub fn evaluate(&self, approvals: &BTreeSet<SignerId>) -> PolicyOutcome {
        let valid: BTreeSet<&SignerId> = approvals
            .iter()
            .filter(|s| self.signers.contains(*s))
            .collect();

        let count = valid.len();
        let weight: u64 = valid.iter().map(|s| self.weight_of(s)).sum();

        let count_ok = count >= self.approval_threshold;
        let weight_ok = self.weight_threshold == 0 || weight >= self.weight_threshold;

        if count_ok && weight_ok {
            PolicyOutcome::Satisfied { count, weight }
        } else {
            PolicyOutcome::Pending {
                count,
                weight,
                needed_count: self.approval_threshold.saturating_sub(count),
                needed_weight: self.weight_threshold.saturating_sub(weight),
            }
        }
    }
}

/// Result of evaluating a policy against collected approvals.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyOutcome {
    /// Thresholds are met.
    Satisfied { count: usize, weight: u64 },
    /// More approvals are required.
    Pending {
        count: usize,
        weight: u64,
        needed_count: usize,
        needed_weight: u64,
    },
}

/// Lifecycle state of a governance proposal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProposalState {
    /// Collecting approvals.
    Open,
    /// Thresholds met, waiting for the time-lock to elapse.
    Approved,
    /// Executed successfully.
    Executed,
    /// Blocked by a veto.
    Vetoed,
    /// Cancelled by a proposer or signer.
    Cancelled,
    /// Expired without execution.
    Expired,
}

/// A governance proposal with a time-locked lifecycle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposal {
    pub id: u64,
    pub proposer: SignerId,
    pub created_at: u64,
    pub approvals: BTreeSet<SignerId>,
    pub state: ProposalState,
    /// Timestamp at which the time-lock completes (set on approval).
    pub executable_at: Option<u64>,
}

/// Errors surfaced by the governance engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GovernanceError {
    UnknownProposal(u64),
    UnauthorizedSigner(SignerId),
    InvalidState(ProposalState),
    TimeLockActive { executable_at: u64, now: u64 },
    ProposalExpired,
    AlreadyVetoed,
}

/// Audit trail entry recording a governance action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditEntry {
    pub proposal_id: u64,
    pub actor: SignerId,
    pub action: AuditAction,
    pub at: u64,
}

/// Actions captured in the audit trail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditAction {
    Created,
    Approved,
    Vetoed,
    Executed,
    EmergencyExecuted,
    Cancelled,
    Expired,
}

/// The governance engine coordinating proposals, policies, and audit trail.
#[derive(Debug, Clone)]
pub struct GovernanceEngine {
    policy: ThresholdPolicy,
    proposals: BTreeMap<u64, Proposal>,
    audit: Vec<AuditEntry>,
    next_id: u64,
}

impl GovernanceEngine {
    /// Creates a new engine with the given policy.
    pub fn new(policy: ThresholdPolicy) -> Self {
        Self {
            policy,
            proposals: BTreeMap::new(),
            audit: Vec::new(),
            next_id: 1,
        }
    }

    /// Returns the immutable audit trail.
    pub fn audit_trail(&self) -> &[AuditEntry] {
        &self.audit
    }

    /// Returns a proposal by id.
    pub fn proposal(&self, id: u64) -> Option<&Proposal> {
        self.proposals.get(&id)
    }

    fn record(&mut self, proposal_id: u64, actor: SignerId, action: AuditAction, at: u64) {
        self.audit.push(AuditEntry {
            proposal_id,
            actor,
            action,
            at,
        });
    }

    /// Creates a new open proposal.
    pub fn create_proposal(&mut self, proposer: SignerId, now: u64) -> Result<u64, GovernanceError> {
        if !self.policy.signers.contains(&proposer) {
            return Err(GovernanceError::UnauthorizedSigner(proposer));
        }
        let id = self.next_id;
        self.next_id += 1;
        self.proposals.insert(
            id,
            Proposal {
                id,
                proposer: proposer.clone(),
                created_at: now,
                approvals: BTreeSet::new(),
                state: ProposalState::Open,
                executable_at: None,
            },
        );
        self.record(id, proposer, AuditAction::Created, now);
        Ok(id)
    }

    /// Records an approval and advances the lifecycle when thresholds are met.
    pub fn approve(
        &mut self,
        id: u64,
        signer: SignerId,
        now: u64,
    ) -> Result<PolicyOutcome, GovernanceError> {
        if !self.policy.signers.contains(&signer) {
            return Err(GovernanceError::UnauthorizedSigner(signer));
        }
        let policy = self.policy.clone();
        let proposal = self
            .proposals
            .get_mut(&id)
            .ok_or(GovernanceError::UnknownProposal(id))?;

        if proposal.state != ProposalState::Open {
            return Err(GovernanceError::InvalidState(proposal.state.clone()));
        }
        if policy.proposal_ttl_secs > 0 && now > proposal.created_at + policy.proposal_ttl_secs {
            proposal.state = ProposalState::Expired;
            let actor = signer.clone();
            self.record(id, actor, AuditAction::Expired, now);
            return Err(GovernanceError::ProposalExpired);
        }

        proposal.approvals.insert(signer.clone());
        let outcome = policy.evaluate(&proposal.approvals);
        if let PolicyOutcome::Satisfied { .. } = outcome {
            proposal.state = ProposalState::Approved;
            proposal.executable_at = Some(now + policy.time_lock_secs);
        }
        self.record(id, signer, AuditAction::Approved, now);
        Ok(outcome)
    }

    /// Vetoes a proposal using an authorized veto signer.
    pub fn veto(&mut self, id: u64, signer: SignerId, now: u64) -> Result<(), GovernanceError> {
        if !self.policy.veto_signers.contains(&signer) {
            return Err(GovernanceError::UnauthorizedSigner(signer));
        }
        let proposal = self
            .proposals
            .get_mut(&id)
            .ok_or(GovernanceError::UnknownProposal(id))?;
        match proposal.state {
            ProposalState::Open | ProposalState::Approved => {
                proposal.state = ProposalState::Vetoed;
            }
            ProposalState::Vetoed => return Err(GovernanceError::AlreadyVetoed),
            ref other => return Err(GovernanceError::InvalidState(other.clone())),
        }
        self.record(id, signer, AuditAction::Vetoed, now);
        Ok(())
    }

    /// Executes an approved proposal once its time-lock has elapsed.
    pub fn execute(&mut self, id: u64, signer: SignerId, now: u64) -> Result<(), GovernanceError> {
        if !self.policy.signers.contains(&signer) {
            return Err(GovernanceError::UnauthorizedSigner(signer));
        }
        let proposal = self
            .proposals
            .get_mut(&id)
            .ok_or(GovernanceError::UnknownProposal(id))?;
        if proposal.state != ProposalState::Approved {
            return Err(GovernanceError::InvalidState(proposal.state.clone()));
        }
        if let Some(executable_at) = proposal.executable_at {
            if now < executable_at {
                return Err(GovernanceError::TimeLockActive { executable_at, now });
            }
        }
        proposal.state = ProposalState::Executed;
        self.record(id, signer, AuditAction::Executed, now);
        Ok(())
    }

    /// Emergency execution path bypassing the normal threshold and time-lock flow.
    pub fn emergency_execute(
        &mut self,
        id: u64,
        signer: SignerId,
        now: u64,
    ) -> Result<(), GovernanceError> {
        if !self.policy.emergency_signers.contains(&signer) {
            return Err(GovernanceError::UnauthorizedSigner(signer));
        }
        let proposal = self
            .proposals
            .get_mut(&id)
            .ok_or(GovernanceError::UnknownProposal(id))?;
        match proposal.state {
            ProposalState::Open | ProposalState::Approved => {
                proposal.state = ProposalState::Executed;
            }
            ref other => return Err(GovernanceError::InvalidState(other.clone())),
        }
        self.record(id, signer, AuditAction::EmergencyExecuted, now);
        Ok(())
    }

    /// Cancels an open or approved proposal.
    pub fn cancel(&mut self, id: u64, signer: SignerId, now: u64) -> Result<(), GovernanceError> {
        if !self.policy.signers.contains(&signer) {
            return Err(GovernanceError::UnauthorizedSigner(signer));
        }
        let proposal = self
            .proposals
            .get_mut(&id)
            .ok_or(GovernanceError::UnknownProposal(id))?;
        match proposal.state {
            ProposalState::Open | ProposalState::Approved => {
                proposal.state = ProposalState::Cancelled;
            }
            ref other => return Err(GovernanceError::InvalidState(other.clone())),
        }
        self.record(id, signer, AuditAction::Cancelled, now);
        Ok(())
    }

    /// Marks a proposal as expired if its lifetime has elapsed.
    pub fn expire(&mut self, id: u64, now: u64) -> Result<(), GovernanceError> {
        let ttl = self.policy.proposal_ttl_secs;
        let proposal = self
            .proposals
            .get_mut(&id)
            .ok_or(GovernanceError::UnknownProposal(id))?;
        if proposal.state != ProposalState::Open {
            return Err(GovernanceError::InvalidState(proposal.state.clone()));
        }
        if ttl > 0 && now > proposal.created_at + ttl {
            proposal.state = ProposalState::Expired;
            let actor = proposal.proposer.clone();
            self.record(id, actor, AuditAction::Expired, now);
            Ok(())
        } else {
            Err(GovernanceError::InvalidState(proposal.state.clone()))
        }
    }
}
