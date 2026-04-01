/**
 * Test Configuration
 * ─────────────────────────────────────────────────────────────────────────────
 * Central config for all API tests.
 * Tests run against the LIVE local backend (localhost:5001).
 * All test data is prefixed [TEST] and cleaned up in afterAll.
 */

export const BASE_URL = "http://localhost:5001/api/v1";

export const TIMEOUT_MS = 10_000;

// Known user IDs from crm_db (real production data — read-only reference)
export const USERS = {
  superAdmin: {
    id:       "69c292eedfdfb199643b9fde",
    email:    "superadmin@crm.com",
    password: "SuperAdmin@123",
    name:     "Super Admin",
  },
  abshar: {
    id:    "69c2933e25f9d4f21c7f2c62",
    name:  "abshar",
  },
  testBDE: {
    id:    "69c3912be7ab107f9d85a8c0",
    name:  "testBDE",
  },
  riziwin: {
    id:    "69c3ae1ee24329e81f4567b5",
    name:  "Riziwin",
  },
  xellarfx: {
    id:    "69c3c3a70f426f633f60ee42",
    name:  "xellarfx fx",
  },
} as const;

// Prefix for all test-created data — makes cleanup safe and obvious in DB
export const TEST_PREFIX = "[TEST]";
