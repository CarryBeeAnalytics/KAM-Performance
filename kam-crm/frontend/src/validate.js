// Input rules shared by the Flag-tab forms. The backend enforces the same
// rules; these only let a form explain the problem before saving.

const DRIVE_LINK = /^https:\/\/(drive|docs)\.google\.com\/\S+$/i;

export function isDriveLink(value) {
  return DRIVE_LINK.test(String(value || "").trim());
}

export const DRIVE_HINT = "Only Google Drive links (https://drive.google.com/…) are accepted.";

export function wordCount(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

/** Case-insensitive match on Business ID or Business Name. */
export function matchesMerchant(row, search) {
  const needle = String(search || "").trim().toLowerCase();
  if (!needle) return true;
  return (
    String(row.business_id).includes(needle) ||
    String(row.business_name || "").toLowerCase().includes(needle)
  );
}
