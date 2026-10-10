// Lead import rules shared by the browser, the server actions and the tests (design docs/evidence/day3b/design.md,
// sections 2.3, 3.2 and 3.5). The code lists must equal the CHECK lists in the lead import migration
// (tests/unit/parity.spec.ts compares them). Pure module: no DOM, no React, no server-only imports.
import { leadStatuses, type LeadStatus } from "../leads";

export { leadStatuses, type LeadStatus };

// Row problems set by the browser rules. A row with any problem is sent as {row_no, problems} only (no values).
export const PROBLEM_CODES = [
  "name_missing",
  "name_too_long",
  "columns_extra",
  "cell_too_long",
  "email_invalid",
  "phone_invalid",
  "phone_mangled",
  "phone_too_long",
  "date_invalid",
  "date_future",
  "date_too_old",
  "city_too_long",
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

// Problems that always reject the row, whatever BAD_FIELD_POLICY says.
export const ROW_PROBLEMS = ["name_missing", "name_too_long", "columns_extra", "cell_too_long"] as const;
export type RowProblem = (typeof ROW_PROBLEMS)[number];
export type FieldProblem = Exclude<ProblemCode, RowProblem>;

// What happened to a row that is still imported (a field left empty, an owner or country not recognised).
export const FIX_CODES = [
  "email_dropped",
  "phone_dropped",
  "date_dropped",
  "city_dropped",
  "owner_unassigned",
  "country_dropped",
] as const;
export type FixCode = (typeof FIX_CODES)[number];

// With BAD_FIELD_POLICY = 'blank_field' a field problem becomes this fix and the field is left empty.
export const FIELD_PROBLEM_FIX: Readonly<Record<FieldProblem, FixCode>> = {
  email_invalid: "email_dropped",
  phone_invalid: "phone_dropped",
  phone_mangled: "phone_dropped",
  phone_too_long: "phone_dropped",
  date_invalid: "date_dropped",
  date_future: "date_dropped",
  date_too_old: "date_dropped",
  city_too_long: "city_dropped",
};

// Set only by SQL during the check; the UI needs a label for each.
export const REASON_CODES = [
  "owner_unknown",
  "date_out_of_range",
  "db_name",
  "db_phone",
  "db_email",
  "db_city",
  "db_country",
  "db_status",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export const OUTCOMES = ["pending", "ready", "rejected", "duplicate_file", "duplicate_existing", "imported"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const MATCH_KEYS = ["email", "phone", "name"] as const;
export type MatchKey = (typeof MATCH_KEYS)[number];

// Every import write needs an authenticator code from the last 10 minutes (has_recent_aal2(600) in SQL).
export const STEP_UP_SECONDS = 600;

// Bad email, phone, date or city: reject the row (Haider's open question 1, recommended) or import it without that field.
export const BAD_FIELD_POLICIES = ["reject_row", "blank_field"] as const;
export type BadFieldPolicy = (typeof BAD_FIELD_POLICIES)[number];
export const BAD_FIELD_POLICY: BadFieldPolicy = "reject_row";

export const LIMITS = {
  /** Largest file accepted, in bytes. */
  maxFileBytes: 15 * 1024 * 1024,
  /** Data rows, counting blank rows inside the data (so the last data row is at most row 50,001). */
  maxDataRows: 50_000,
  /** Spreadsheet row numbers of data rows: the header is row 1. */
  minRowNo: 2,
  maxRowNo: 50_001,
  maxColumns: 100,
  /** Characters (code points) in one header cell. */
  maxHeaderChars: 200,
  /** Characters (code points) in one data cell of an imported column; more is row problem cell_too_long. */
  maxCellChars: 2_000,
  /** Rows per stage_lead_import_rows call. */
  chunkRows: 1_000,
  /** UTF-8 bytes of one call's JSON rows array (under the 1 MB server action limit). */
  chunkBytes: 750 * 1024,
  /** Problem or fix codes on one row. */
  maxCodes: 16,
  /** More distinct unmatched values than this in one field: "Is this the right column?". */
  maxDistinctUnmatched: 200,
  // The companies table's rules (characters are code points, like Postgres char_length).
  maxNameChars: 200,
  maxPhoneChars: 40,
  maxEmailChars: 254,
  maxCityChars: 120,
  minPhoneDigits: 6,
} as const;

// The papaparse slice size: each slice yields to the main thread.
export const PARSE_CHUNK_CHARS = 256 * 1024;
export const DELIMITERS = [",", ";", "\t", "|"] as const;
export type Delimiter = (typeof DELIMITERS)[number];

// Oldest accepted last-activity date (local time in the source time zone).
export const MIN_ACTIVITY_LOCAL = "1990-01-01T00:00:00";
export const DEFAULT_TIME_ZONE = "Europe/Paris";
export const DEFAULT_STATUS: LeadStatus = "cold";

// Status words a sheet may use, after aliasKey() folding (accents and case removed, punctuation to spaces).
// EN and FR labels from messages/*.json, Haider's spelling, HubSpot internal values. "Hot lead" and "Prospect" are
// deliberately absent: an unknown word needs an explicit choice in the UI.
export const STATUS_ALIASES: ReadonlyArray<readonly [string, LeadStatus]> = [
  ["cold", "cold"],
  ["froid", "cold"],
  ["warm", "warm"],
  ["warm in progress", "warm"],
  ["in progress", "warm"],
  ["tiede", "warm"],
  ["tiede en cours", "warm"],
  ["en cours", "warm"],
  ["negotiation", "negotiation"],
  ["negotiations", "negotiation"],
  ["in negotiation", "negotiation"],
  ["negociation", "negotiation"],
  ["negociations", "negotiation"],
  ["en negociation", "negotiation"],
  ["customer", "customer"],
  ["customers", "customer"],
  ["client", "customer"],
  ["clients", "customer"],
  ["cliente", "customer"],
  ["cool off", "cool_off"],
  ["cooloff", "cool_off"],
  ["en pause", "cool_off"],
  ["do not contact", "do_not_contact"],
  ["dont contact", "do_not_contact"],
  ["don t contact", "do_not_contact"],
  ["dnc", "do_not_contact"],
  ["ne pas contacter", "do_not_contact"],
  ["disqualified", "disqualified"],
  ["unqualified", "disqualified"],
  ["disqualifie", "disqualified"],
  ["disqualifiee", "disqualified"],
  ["non qualifie", "disqualified"],
  ["non qualifiee", "disqualified"],
];

// Typed errors that stop reading a file. The UI maps `code` to a message (messages/*.json, Import.errors.*).
export const FILE_ERROR_CODES = [
  "not_csv",
  "too_big",
  "excel_file",
  "not_text",
  "empty",
  "no_header",
  "no_rows",
  "header_too_long",
  "too_many_columns",
  "too_many_rows",
  "quote_error",
  "aborted",
] as const;
export type FileErrorCode = (typeof FILE_ERROR_CODES)[number];

export class ImportFileError extends Error {
  readonly code: FileErrorCode;
  /** Spreadsheet row number (header = row 1) for too_many_rows and quote_error. */
  readonly rowNo: number | null;
  constructor(code: FileErrorCode, rowNo: number | null = null) {
    super(code);
    this.name = "ImportFileError";
    this.code = code;
    this.rowNo = rowNo;
  }
}

// A caller broke a precondition (for example normalising before every status value has a choice). Never user data.
export class ImportRulesError extends Error {
  constructor(code: "name_unmapped" | "status_unmapped" | "bad_time_zone" | "row_too_big") {
    super(code);
    this.name = "ImportRulesError";
  }
}
