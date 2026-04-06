/**
 * Team Member Active / Inactive — Auto-Assign Flow
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests every scenario involving the toggle-active flag and how it affects
 * the auto-assign lead distribution engine.
 *
 * Endpoint coverage:
 *   PATCH  /teams/:id/members/:memberId/toggle-active   (activate / deactivate)
 *   POST   /teams/:id/auto-assign                       (distribute leads)
 *   GET    /teams/:id                                   (verify inactiveMembers)
 *   GET    /leads/:id                                   (verify assignee)
 *
 * Test Matrix
 * ────────────────────────────────────────────────────────────────────────────
 *  #   Scenario                                                     Expected
 *  ─   ─────────────────────────────────────────────────────────────────────
 *  1   Toggle member → inactive                                     200, in inactiveMembers
 *  2   Inactive member excluded from auto-assign                    200, 0 leads to inactive
 *  3   Re-activate member                                           200, NOT in inactiveMembers
 *  4   Re-activated member included again                           200, receives leads
 *  5   Toggle idempotency (toggle twice = back to original)         200, state restored
 *  6   All 3 members deactivated → auto-assign fails                400
 *  7   Deactivate 2, leave 1 active → all leads go to 1 member     200, single-member split
 *  8   Leader is NEVER included even when all regular members off   400 (no available members)
 *  9   Non-member toggle → 400                                      400
 * 10   Toggle without token → 401                                   401
 * 11   Full cycle: inactive → assign → reactivate → reassign        split matches member count
 * 12   Toggle already-inactive member re-activates (idempotent)     200, removed from list
 * 13   Multiple simultaneous inactive toggles work correctly        200
 * 14   Load-balance: inactive excluded, active get even split       equal distribution
 * 15   inactiveMembers list reflects correct count after toggles    count === deactivated
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { api }                  from "../helpers/auth.js";
import {
  createTestTeam,  deleteTestTeam,
  createTestLead,  deleteTestLeads,
  getLeadAssignee, unassignLead,
  type CreatedTeam, type CreatedLead,
} from "../helpers/factory.js";
import { USERS } from "../config.js";

// ─── Shared state ─────────────────────────────────────────────────────────────

let team:    CreatedTeam;
let leads:   CreatedLead[];
let leadIds: string[];

const M1     = USERS.abshar.id;       // active member 1
const M2     = USERS.testBDE.id;      // active member 2
const M3     = USERS.riziwin.id;      // active member 3
const LEADER = USERS.superAdmin.id;   // team leader — never receives leads
const OUTSIDER = USERS.xellarfx.id;  // not in this team at all

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function toggle(memberId: string): Promise<Response> {
  return api(`/teams/${team._id}/members/${memberId}/toggle-active`, { method: "PATCH" });
}

async function autoAssign(leadIdsOverride?: string[]): Promise<Response> {
  return api(`/teams/${team._id}/auto-assign`, {
    method: "POST",
    body:   JSON.stringify(leadIdsOverride ? { leadIds: leadIdsOverride } : {}),
  });
}

async function getInactiveMembers(): Promise<string[]> {
  const res  = await api(`/teams/${team._id}`);
  const json = (await res.json()) as {
    data: { inactiveMembers: ({ _id?: string } | string)[] }
  };
  return (json.data.inactiveMembers ?? []).map((m) =>
    typeof m === "string" ? m : ((m as { _id?: string })._id ?? String(m))
  );
}

/** Ensure all 3 regular members are active (called in afterEach to isolate tests) */
async function reactivateAll(): Promise<void> {
  const inactive = await getInactiveMembers();
  await Promise.all(inactive.map((id) => toggle(id)));
}

async function resetLeads(): Promise<void> {
  await Promise.all(leadIds.map(unassignLead));
}

function countByMember(results: { assignedTo: string }[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const r of results) c[r.assignedTo] = (c[r.assignedTo] ?? 0) + 1;
  return c;
}

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  team = await createTestTeam({
    name:    "[TEST] ActiveInactive Suite",
    leaders: [LEADER],
    members: [M1, M2, M3],
  });

  // 6 leads — 2 per member when all 3 are active
  leads = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      createTestLead({ name: `[TEST] AI-Lead ${i + 1}`, teamId: team._id, assignedTo: null })
    )
  );
  leadIds = leads.map((l) => l._id);

  console.log(`\n✅ Setup: team=${team._id}  leads=${leadIds.length}`);
});

afterAll(async () => {
  await reactivateAll();
  await deleteTestLeads(leadIds);
  await deleteTestTeam(team._id);
  console.log("\n🧹 Cleanup complete");
});

afterEach(async () => {
  // Isolate each test: restore member state + unassign all leads
  await reactivateAll();
  await resetLeads();
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP 1 — Toggle Active / Inactive
// ═════════════════════════════════════════════════════════════════════════════

describe("PATCH /teams/:id/members/:memberId/toggle-active", () => {

  it("T01 › deactivating a member adds them to inactiveMembers list", async () => {
    const res = await toggle(M1);
    expect(res.status).toBe(200);

    const inactive = await getInactiveMembers();
    expect(inactive).toContain(M1);
  });

  it("T02 › re-activating a member removes them from inactiveMembers list", async () => {
    await toggle(M1);            // deactivate
    const res = await toggle(M1); // re-activate
    expect(res.status).toBe(200);

    const inactive = await getInactiveMembers();
    expect(inactive).not.toContain(M1);
  });

  it("T03 › toggle is idempotent — toggle twice = back to original state", async () => {
    const before = await getInactiveMembers();

    await toggle(M2);   // deactivate
    await toggle(M2);   // re-activate

    const after = await getInactiveMembers();
    expect(after).toEqual(before);
  });

  it("T04 › deactivating multiple members lists all in inactiveMembers", async () => {
    await toggle(M1);
    await toggle(M2);

    const inactive = await getInactiveMembers();
    expect(inactive).toContain(M1);
    expect(inactive).toContain(M2);
    expect(inactive).not.toContain(M3);
    expect(inactive.length).toBe(2);
  });

  it("T05 › inactiveMembers count is accurate after partial deactivation", async () => {
    await toggle(M3);
    const inactive = await getInactiveMembers();
    expect(inactive.length).toBe(1);
    expect(inactive[0]).toBe(M3);
  });

  it("T06 › cannot toggle a user who is not a member of the team → 400", async () => {
    const res = await toggle(OUTSIDER);
    expect(res.status).toBe(400);
  });

  it("T07 › returns 401 when request has no auth token", async () => {
    const res = await api(
      `/teams/${team._id}/members/${M1}/toggle-active`,
      { method: "PATCH" },
      false,
    );
    expect(res.status).toBe(401);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP 2 — Auto-Assign Respects Inactive Members
// ═════════════════════════════════════════════════════════════════════════════

describe("POST /teams/:id/auto-assign — inactive member exclusion", () => {

  it("T08 › inactive member receives ZERO leads during auto-assign", async () => {
    await toggle(M1);  // deactivate M1

    const res  = await autoAssign();
    const json = (await res.json()) as {
      data: { assigned: number; results: { assignedTo: string }[] }
    };

    expect(res.status).toBe(200);
    expect(json.data.assigned).toBe(6);

    const receivedM1 = json.data.results.some((r) => r.assignedTo === M1);
    expect(receivedM1).toBe(false);
  });

  it("T09 › with 1 inactive: remaining 2 active members split leads evenly", async () => {
    await toggle(M1);  // deactivate M1 — M2 and M3 are active

    const res  = await autoAssign();
    const json = (await res.json()) as {
      data: { results: { assignedTo: string }[] }
    };
    expect(res.status).toBe(200);

    const counts = countByMember(json.data.results);
    expect(counts[M2]).toBe(3);
    expect(counts[M3]).toBe(3);
    expect(counts[M1]).toBeUndefined();
  });

  it("T10 › with 2 inactive: only 1 active member receives ALL leads", async () => {
    await toggle(M1);
    await toggle(M2);
    // Only M3 is active

    const res  = await autoAssign();
    const json = (await res.json()) as {
      data: { assigned: number; results: { assignedTo: string }[] }
    };
    expect(res.status).toBe(200);
    expect(json.data.assigned).toBe(6);

    const counts = countByMember(json.data.results);
    expect(counts[M3]).toBe(6);
    expect(counts[M1]).toBeUndefined();
    expect(counts[M2]).toBeUndefined();
  });

  it("T11 › all 3 members inactive → auto-assign returns 400", async () => {
    await toggle(M1);
    await toggle(M2);
    await toggle(M3);

    const res  = await autoAssign();
    const json = (await res.json()) as { success: boolean; message: string };

    expect(res.status).toBe(400);
    expect(json.message.toLowerCase()).toContain("inactive");
  });

  it("T12 › leader is NEVER assigned leads — even with all regular members inactive", async () => {
    // Deactivate all regular members — only leader remains
    await toggle(M1);
    await toggle(M2);
    await toggle(M3);

    const res  = await autoAssign();
    const json = (await res.json()) as { success: boolean; message: string };

    // Should fail — leader is excluded and no regular active members
    expect(res.status).toBe(400);

    // Verify leader never appears in any results (if somehow 200)
    if (res.status === 200) {
      const j = json as unknown as { data: { results: { assignedTo: string }[] } };
      const leaderGotLead = (j as { data: { results: { assignedTo: string }[] } })
        .data.results.some((r) => r.assignedTo === LEADER);
      expect(leaderGotLead).toBe(false);
    }
  });

  it("T13 › re-activating a member includes them in next auto-assign", async () => {
    await toggle(M1);  // deactivate

    // First assign — M1 excluded
    await autoAssign();
    await resetLeads();

    await toggle(M1);  // re-activate

    // Second assign — M1 should get leads now
    const res  = await autoAssign();
    const json = (await res.json()) as {
      data: { assigned: number; results: { assignedTo: string }[] }
    };
    expect(res.status).toBe(200);

    const receivedM1 = json.data.results.some((r) => r.assignedTo === M1);
    expect(receivedM1).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GROUP 3 — Full Cycle Integration Tests
// ═════════════════════════════════════════════════════════════════════════════

describe("Full cycle: toggle → assign → reactivate → reassign", () => {

  it("T14 › full cycle with 1 member: deactivate → assign 2-way → reactivate → assign 3-way", async () => {
    // ── Round 1: deactivate M3, assign 6 leads ────────────────────────────────
    await toggle(M3);

    const r1 = await autoAssign();
    const j1 = (await r1.json()) as { data: { assigned: number; results: { assignedTo: string }[] } };

    expect(r1.status).toBe(200);
    expect(j1.data.assigned).toBe(6);

    const c1 = countByMember(j1.data.results);
    expect(c1[M1]).toBe(3);
    expect(c1[M2]).toBe(3);
    expect(c1[M3]).toBeUndefined();

    // ── Round 2: reactivate M3, reset, assign 6 leads ─────────────────────────
    await toggle(M3);   // reactivate
    await resetLeads();

    const r2 = await autoAssign();
    const j2 = (await r2.json()) as { data: { assigned: number; results: { assignedTo: string }[] } };

    expect(r2.status).toBe(200);
    expect(j2.data.assigned).toBe(6);

    const c2 = countByMember(j2.data.results);
    expect(c2[M1]).toBe(2);
    expect(c2[M2]).toBe(2);
    expect(c2[M3]).toBe(2);
  });

  it("T15 › toggling same member rapidly produces correct final state", async () => {
    // Toggle M2 ON-OFF-ON-OFF → should end up inactive
    await toggle(M2);  // → inactive
    await toggle(M2);  // → active
    await toggle(M2);  // → inactive
    await toggle(M2);  // → active (final: active)

    const inactive = await getInactiveMembers();
    expect(inactive).not.toContain(M2);

    // Auto-assign should include M2
    const res  = await autoAssign();
    const json = (await res.json()) as { data: { results: { assignedTo: string }[] } };
    expect(res.status).toBe(200);

    const receivedM2 = json.data.results.some((r) => r.assignedTo === M2);
    expect(receivedM2).toBe(true);
  });

  it("T16 › sequential partial deactivations accumulate correctly", async () => {
    // Deactivate M1 then M2 sequentially
    await toggle(M1);
    let inactive = await getInactiveMembers();
    expect(inactive).toContain(M1);
    expect(inactive).not.toContain(M2);

    await toggle(M2);
    inactive = await getInactiveMembers();
    expect(inactive).toContain(M1);
    expect(inactive).toContain(M2);
    expect(inactive).not.toContain(M3);

    // Auto-assign — only M3 active
    const res  = await autoAssign();
    const json = (await res.json()) as { data: { assigned: number; results: { assignedTo: string }[] } };
    expect(res.status).toBe(200);

    const counts = countByMember(json.data.results);
    expect(counts[M3]).toBe(6);
    expect(counts[M1]).toBeUndefined();
    expect(counts[M2]).toBeUndefined();
  });

  it("T17 › specific leadIds auto-assign still respects inactive exclusion", async () => {
    await toggle(M1);  // deactivate M1

    // Only assign 2 specific leads
    const targetIds = [leadIds[0], leadIds[1]];
    const res  = await autoAssign(targetIds);
    const json = (await res.json()) as {
      data: { assigned: number; results: { leadId: string; assignedTo: string }[] }
    };

    expect(res.status).toBe(200);
    expect(json.data.assigned).toBe(2);

    // Neither lead should be assigned to M1
    const receivedM1 = json.data.results.some((r) => r.assignedTo === M1);
    expect(receivedM1).toBe(false);

    // Both leads go to M2 or M3
    json.data.results.forEach((r) => {
      expect([M2, M3]).toContain(r.assignedTo);
    });
  });
});
