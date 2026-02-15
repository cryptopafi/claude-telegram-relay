/**
 * TOTP verification for HARD rule modifications
 * Uses Google Authenticator compatible codes
 */

import * as OTPAuth from "otpauth";

const TOTP_SECRET = process.env.TOTP_SECRET || "";

let totp: OTPAuth.TOTP | null = null;

if (TOTP_SECRET) {
  totp = new OTPAuth.TOTP({
    issuer: "Genie",
    label: "Pafi",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: TOTP_SECRET,
  });
}

/**
 * Verify a TOTP code
 */
export function verifyTOTP(code: string): boolean {
  if (!totp) {
    console.error("TOTP not configured - TOTP_SECRET missing from .env");
    return false;
  }

  // Allow 1 period window (±30 seconds)
  const delta = totp.validate({ token: code, window: 1 });
  return delta !== null;
}

/**
 * Generate a new TOTP secret and return setup info
 * Call this once during initial setup
 */
export function generateTOTPSetup(): {
  secret: string;
  uri: string;
  qrText: string;
} {
  const secret = new OTPAuth.Secret({ size: 20 });

  const newTotp = new OTPAuth.TOTP({
    issuer: "Genie",
    label: "Pafi",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });

  const uri = newTotp.toString();

  return {
    secret: secret.base32,
    uri,
    qrText: `Add to .env:\nTOTP_SECRET=${secret.base32}\n\nScan this URI as QR code in Google Authenticator:\n${uri}`,
  };
}

/**
 * Check if TOTP is configured
 */
export function isTOTPConfigured(): boolean {
  return totp !== null;
}

// Hard rule IDs (rules that require TOTP)
const HARD_RULE_IDS = [
  "SEC-H-001", "SEC-H-002", "SEC-H-003", "SEC-H-004",
  "DEV-H-001", "DEV-H-002", "DEV-H-003",
  "MEM-H-001",
  "COM-H-001", "COM-H-002", "COM-H-003",
  "COST-H-001", "COST-H-002",
];

/**
 * Check if a rule ID is a HARD rule
 */
export function isHardRule(ruleId: string): boolean {
  return HARD_RULE_IDS.includes(ruleId.toUpperCase()) || ruleId.includes("-H-");
}
