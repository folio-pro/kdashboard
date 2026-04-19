mod counts;
mod discovery;
mod listing;
mod schema;
mod types;

#[cfg(test)]
mod tests;

// Re-export all public items to preserve the existing API surface.
// Some re-exports are only consumed via fully-qualified paths or internally;
// suppress the unused-import lint for these.
pub use counts::get_crd_counts;
pub use discovery::discover_crds;
pub use listing::list_crd_resources;
#[allow(unused_imports)]
pub use schema::extract_heuristic_columns;
pub use types::extract_conditions;
#[allow(unused_imports)]
pub use types::{CrdColumn, CrdGroup, CrdInfo, CrdResourceList, StatusCondition};
