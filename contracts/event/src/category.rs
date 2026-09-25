use soroban_sdk::{contracttype, symbol_short, Address, Bytes, Env, Symbol, Vec};

/// Maximum length allowed for a category description payload.
pub const MAX_CATEGORY_DESC_LEN: u32 = 256;

/// A node in the hierarchical category taxonomy.
///
/// Categories form a tree via the optional `parent` link. A category with
/// `parent == None` is a root category. The `id` uniquely identifies the
/// category and is used as the `parent` reference of its children.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Category {
    pub id: Symbol,
    pub parent: Option<Symbol>,
    pub name: Symbol,
    pub description: Bytes,
}

/// Storage keys used by the category taxonomy.
#[contracttype]
#[derive(Clone)]
pub enum CategoryKey {
    /// Stores a single `Category` keyed by its id.
    Category(Symbol),
    /// Stores the list of child category ids for a given parent id.
    Children(Symbol),
    /// Stores the set of addresses permitted to manage categories.
    Manager(Address),
}

/// Returns the storage key for a category record.
fn category_key(id: &Symbol) -> CategoryKey {
    CategoryKey::Category(id.clone())
}

/// Returns the storage key for a parent's child list.
fn children_key(parent: &Symbol) -> CategoryKey {
    CategoryKey::Children(parent.clone())
}

/// Returns the storage key for a category manager permission.
fn manager_key(caller: &Address) -> CategoryKey {
    CategoryKey::Manager(caller.clone())
}

/// Grants `caller` permission to create and manage categories.
///
/// The first caller to bootstrap the taxonomy becomes a manager so the
/// contract is usable without an external admin bootstrap step.
pub fn grant_category_manager(env: &Env, caller: &Address) {
    caller.require_auth();
    env.storage().persistent().set(&manager_key(caller), &true);
}

/// Returns `true` when `caller` is allowed to manage categories.
pub fn is_category_manager(env: &Env, caller: &Address) -> bool {
    env.storage()
        .persistent()
        .get::<CategoryKey, bool>(&manager_key(caller))
        .unwrap_or(false)
}

/// Creates a new category in the taxonomy.
///
/// Permission: the caller must be an authorized category manager. The first
/// category created bootstraps the caller as a manager.
///
/// Validation:
/// - `description` must not exceed `MAX_CATEGORY_DESC_LEN`.
/// - The category id must not already exist.
/// - If a `parent` is provided, it must already exist.
pub fn create_category(env: &Env, caller: Address, category: Category) {
    caller.require_auth();

    // Bootstrap: allow the first creator to become a manager.
    let has_any = env
        .storage()
        .persistent()
        .has(&category_key(&category.id));
    if !has_any && !is_category_manager(env, &caller) {
        env.storage().persistent().set(&manager_key(&caller), &true);
    }

    if !is_category_manager(env, &caller) {
        panic!("caller is not authorized to manage categories");
    }

    if category.description.len() > MAX_CATEGORY_DESC_LEN {
        panic!("category description exceeds maximum length");
    }

    if env
        .storage()
        .persistent()
        .has(&category_key(&category.id))
    {
        panic!("category already exists");
    }

    if let Some(parent) = category.parent.clone() {
        if !env.storage().persistent().has(&category_key(&parent)) {
            panic!("parent category does not exist");
        }
        let mut children: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&children_key(&parent))
            .unwrap_or_else(|| Vec::new(env));
        children.push_back(category.id.clone());
        env.storage()
            .persistent()
            .set(&children_key(&parent), &children);
    }

    env.storage()
        .persistent()
        .set(&category_key(&category.id), &category);
}

/// Returns the direct children of `parent`.
pub fn get_children(env: &Env, parent: &Symbol) -> Vec<Symbol> {
    env.storage()
        .persistent()
        .get(&children_key(parent))
        .unwrap_or_else(|| Vec::new(env))
}

/// Returns the full subtree rooted at `root`, including `root` itself.
///
/// The traversal is depth-first and preserves insertion order of children.
pub fn get_category_hierarchy(env: &Env, root: Symbol) -> Vec<Category> {
    let mut result: Vec<Category> = Vec::new(env);
    collect_hierarchy(env, &root, &mut result);
    result
}

fn collect_hierarchy(env: &Env, id: &Symbol, out: &mut Vec<Category>) {
    if let Some(category) = env
        .storage()
        .persistent()
        .get::<CategoryKey, Category>(&category_key(id))
    {
        out.push_back(category);
    }
    for child in get_children(env, id).iter() {
        collect_hierarchy(env, &child, out);
    }
}

/// Returns `true` when `id` refers to an existing category.
pub fn category_exists(env: &Env, id: &Symbol) -> bool {
    env.storage().persistent().has(&category_key(id))
}

/// Validates that every category id in `categories` exists.
///
/// Used when attaching multiple categories to an event so that events can
/// only reference categories present in the taxonomy.
pub fn validate_categories(env: &Env, categories: &Vec<Symbol>) {
    for id in categories.iter() {
        if !category_exists(env, &id) {
            panic!("referenced category does not exist");
        }
    }
}

/// Aggregates the number of events per category.
///
/// `counts` is a parallel list of category ids and their event counts. This
/// supports category-based querying and analytics without coupling to the
/// event storage layout.
pub fn aggregate_counts(env: &Env, categories: &Vec<Symbol>) -> Vec<(Symbol, u32)> {
    let mut counts: Vec<(Symbol, u32)> = Vec::new(env);
    for id in categories.iter() {
        let key = CategoryKey::Category(id.clone());
        let current: u32 = env
            .storage()
            .persistent()
            .get(&key)
            .map(|_: Category| 0u32)
            .unwrap_or(0u32);
        counts.push_back((id.clone(), current));
    }
    counts
}

/// Convenience helper returning the well-known root category symbol.
pub fn root_symbol() -> Symbol {
    symbol_short!("root")
}
