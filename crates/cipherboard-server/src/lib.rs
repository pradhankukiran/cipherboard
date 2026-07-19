pub mod config;
pub mod error;
pub mod limits;
pub mod protocol;
pub mod rate_limit;
pub mod routes;
pub mod state;
pub mod ws;

#[cfg(test)]
mod tests {
    use super::limits::*;

    #[test]
    fn id_validation() {
        assert!(valid_id("rm_abc-123"));
        assert!(!valid_id(""));
        assert!(!valid_id("has space"));
    }

    #[test]
    fn display_name_validation() {
        assert!(valid_display_name("Ada"));
        assert!(!valid_display_name(""));
        assert!(!valid_display_name(&"x".repeat(200)));
    }

    #[test]
    fn b64_validation() {
        assert!(valid_b64("abcABC123+/=_-", 64));
        assert!(!valid_b64("", 64));
        assert!(!valid_b64("!!!", 64));
    }
}
