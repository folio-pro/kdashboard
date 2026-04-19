mod aggregation;
mod pod;
pub mod types;
mod workload;

#[cfg(test)]
mod tests;

// Re-export public API
pub use aggregation::diagnose_resource;
pub use types::DiagnosticResult;
