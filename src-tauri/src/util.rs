use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// Current UTC time as an ISO 8601 / RFC 3339 string, the format used in all data files.
pub fn now_iso() -> String {
    OffsetDateTime::now_utc().format(&Rfc3339).unwrap_or_default()
}
