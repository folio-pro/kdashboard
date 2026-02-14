#![recursion_limit = "1024"]

mod deployment_details;
mod detail_shared;
mod detail_tabs;
mod details;
mod generic_details;
mod hpa_details;
mod pod_details;
mod port_forward_view;
mod replicaset_details;
mod table;
mod vpa_details;

pub use deployment_details::*;
pub use detail_shared::*;
pub use details::*;
pub use generic_details::*;
pub use hpa_details::*;
pub use pod_details::*;
pub use port_forward_view::*;
pub use replicaset_details::*;
pub use table::*;
pub use vpa_details::*;
