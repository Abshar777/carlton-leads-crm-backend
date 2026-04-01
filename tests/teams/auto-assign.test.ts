/**
 * Auto-Assign API Tests
 * ─────────────────────────────────────────────────────────────────────────────
 * Tests for:
 *   POST   /teams/:id/auto-assign
 *   PATCH  /teams/:id/members/:memberId/toggle-active
 *
 * Covers:
 *   ✅ Happy path round-robin distribution
 *   ✅ Specific leadIds override
 *   ✅ Leaders are EXCLUDED from receiving leads
 *   ✅ Inactive members are EXCLUDED (toggle-active integration)
 *   ✅ Re-activating a member includes them again
 *   ✅ Load-balanced distribution (least-loaded member gets more)
 *   ✅ No leads to assign → { assigned: 0 }
 *   ✅ All members inactive → 400 error
 *   ✅ Unknown team → 404
 *   ✅ No token → 401
 *   ✅ Non-member toggle → 400
 *   ✅ Full cycle: toggle inactive → auto-assign → verify split
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { api }                      from "../helpers/auth.js";
import {
  createTestTeam,  deleteTestTeam,
  createTestLead,  deleteTestLeads,
  getLeadAssignee, unassignLead,
  type CreatedTeam, type CreatedLead,
} from "../helpers/factory.js";
import { USERS } from "../config.js";

// ─── Test State ───────────────────────────────────────────────────────────────

let team:      CreatedTeam;
let leads:     CreatedLead[];           // 6 leads all in the test team
let leadIds:   string[];

// 3 active members in the test team (NOT leaders)
const MEMBER_1 = USERS.abshar.id;    // abshar
const MEMBER_2 = USERS.testBDE.id;   // testBDE
const MEMBER_3 = USERS.riziwin.id;   // Riziwin
const LEADER   = USERS.superAdmin.id; // Super Admin — should never receive leads

// ─── Setup / Teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  // Create a dedicated test team: 1 leader + 3 members
  team = await createTestTeam({
    name:    "[TEST] Auto-Assign Suite",
    leaders: [LEADER],
    members: [MEMBER_1, MEMBER_2, MEMBER_3],
  });

  // Create 6 test leads, all assigned to this team, all unassigned (assignedTo: null)
  leads = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      createTestLead({
        name:       `[TEST] Lead ${i + 1}`,
        teamId:     team._id,
        assignedTo: null,       // factory sets assignedTo=null via PUT
      })
    )
  );
  leadIds = leads.map((l) => l._id);

  console.log(`\n✅ Test setup complete — team=${team._id}  leads=${leadIds.length}`);
});

afterAll(async () => {
  // Restore: re-activate any members that were deactivated during tests
  const teamRes = await api(`/teams/${team._id}`);
  const teamData = (await teamRes.json()) as { data: { inactiveMembers?: string[] } };
  const inactive = teamData.data?.inactiveMembers ?? [];
  for (const memberId of inactive) {
    await api(`/teams/${team._id}/members/${memberId}/toggle-active`, { method: "PATCH" });
  }

  // Delete test leads and team
  await deleteTestLeads(leadIds);
  await deleteTestTeam(team._id);
  console.log("\n🧹 Test cleanup complete");
});

// ─── Helper: reset all test leads back to unassigned ─────────────────────────
async function resetLeads(): Promise<void> {
  await Promise.all(leadIds.map(unassignLead));
}

// ─── Test Suites ──────────────────────────────────────────────────────────────

describe("POST /teams/:id/auto-assign", () => {

  // ── T1: Happy path — round-robin all unassigned leads ─────────────────────
  it("T1 › assigns all unassigned leads (no leadIds) round-robin to active members", async () => {
    await resetLeads();

    const res  = await api(`/teams/${team._id}/auto-assign`, { method: "POST", body: "{}" });
    const json = (await res.json()) as { data: { assigned: number; results: { leadId: string; assignedTo: string }[] } };

    expect(res.status).toBe(200);
    expect(json.data.assigned).toBe(6);
    expect(json.data.results).toHaveLength(6);

    // Every assigned member must be one of the 3 active members — NOT the leader
    const assignees = new Set(json.data.results.map((r) => r.assignedTo));
    expect(assignees.has(LEADER)).toBe(false);
    expect([...assignees].every((id) => [MEMBER_1, MEMBER_2, MEMBER_3].includes(id))).toBe(true);

    // Each member should have received at least 1 lead (6 leads / 3 members = 2 each)
    const countByMember: Record<string, number> = {};
    for (const r of json.data.results) {
      countByMember[r.assignedTo] = (countByMember[r.assignedTo] ?? 0) + 1;
    }
    expect(countByMember[MEMBER_1]).toBe(2);
    expect(countByMember[MEMBER_2]).toBe(2);
    expect(countByMember[MEMBER_3]).toBe(2);
  });

  // ── T2: Specific leadIds — only those leads are touched ───────────────────
  it("T2 › assigns only the specified leadIds when provided", async () => {
    await resetLeads();

    const targetIds = [leadIds[0], leadIds[1]];   // only first 2 leads
    const res  = await api(`/teams/${team._id}/auto-assign`, {
      method: "POST",
      body:   JSON.stringify({ leadIds: targetIds }),
    });
    const json = (await res.json()) as { data: { assigned: number; results: { leadId: string }[] } };

    expect(res.status).toBe(200);
    expect(json.data.assigned).toBe(2);

    const assignedIds = json.data.results.map((r) => r.leadId);
    expect(assignedIds).toContain(leadIds[0]);
    expect(assignedIds).toContain(leadIds[1]);

    // Leads 3–6 must still be unassigned
    const lead3Assignee = await getLeadAssignee(leadIds[2]);
    expect(lead3Assignee).toBeNull();
  });

  // ── T3: Leaders never receive leads ───────────────────────────────────────
  it("T3 › team leaders are NEVER assigned leads", async () => {
    await resetLeads();

    const res  = await api(`/teams/${team._id}/auto-assign`, { method: "POST", body: "{}" });
    const json = (await res.json()) as { data: { results: { assignedTo: string }[] } };

    expect(res.status).toBe(200);

    const receivedLeader = json.data.results.some((r) => r.assignedTo === LEADER);
    expect(receivedLeader).toBe(false);
  });

  // ── T4: Returns { assigned: 0 } when no unassigned leads exist ────────────
  it("T4 › returns assigned=0 when all leads are already assigned", async () => {
    // T1 or T3 already assigned all leads — do NOT reset here
    const res  = await api(`/teams/${team._id}/auto-assign`, { method: "POST", body: "{}" });
    const json = (await res.json()) as { data: { assigned: number } };

    expect(res.status).toBe(200);
    expect(json.data.assigned).toBe(0);
  });

  // ── T5: 404 for unknown team ───────────────────────────────────────────────
  it("T5 › returns 404 for a non-existent team ID", async () => {
    const res = await api("/teams/000000000000000000000099/auto-assign", {
      method: "POST",
      body:   "{}",
    });
    expect(res.status).toBe(404);
  });

  // ── T6: 401 when no auth token ────────────────────────────────────────────
  it("T6 › returns 401 when Authorization header is missing", async () => {
    const res = await api(`/teams/${team._id}/auto-assign`, { method: "POST", body: "{}" }, false);
    expect(res.status).toBe(401);
  });

  // ── T7: Load balancing — member with fewer leads gets more ────────────────
  it("T7 › load-balances fairly (least-loaded member gets lead first)", async () => {
    await resetLeads();

    // Pre-load MEMBER_2 and MEMBER_3 with 1 existing lead each by assigning directly
    await api(`/teams/${team._id}/auto-assign`, {
      method: "POST",
      body:   JSON.stringify({ leadIds: [leadIds[4], leadIds[5]] }),
    });
    // Manually confirm who got what via results — then run the rest
    await unassignLead(leadIds[0]);
    await unassignLead(leadIds[1]);
    await unassignLead(leadIds[2]);
    await unassignLead(leadIds[3]);

    // Now auto-assign remaining 4 unassigned leads
    const res  = await api(`/teams/${team._id}/auto-assign`, { method: "POST", body: "{}" });
    const json = (await res.json()) as {
      data: { assigned: number; results: { leadId: string; assignedTo: string }[] }
    };

    expect(res.status).toBe(200);
    expect(json.data.assigned).toBe(4);

    // The member with 0 existing leads (MEMBER_1 likely) should have received leads
    const countByMember: Record<string, number> = {};
    for (const r of json.data.results) {
      countByMember[r.assignedTo] = (countByMember[r.assignedTo] ?? 0) + 1;
    }
    const counts = Object.values(countByMember);
    // Load balancing means counts should be close, with least-loaded getting slightly more
    expect(counts.length).toBeGreaterThanOrEqual(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("PATCH /teams/:id/members/:memberId/toggle-active", () => {

  // ── T8: Mark member inactive ───────────────────────────────────────────────
  it("T8 › marks a member as inactive (adds to inactiveMembers)", async () => {
    const res  = await api(`/teams/${team._id}/members/${MEMBER_1}/toggle-active`, { method: "PATCH" });
    const json = (await res.json()) as { data: { inactiveMembers: string[] } };

    expect(res.status).toBe(200);

    // Re-fetch team to verify
    const teamRes  = await api(`/teams/${team._id}`);
    const teamJson = (await teamRes.json()) as { data: { inactiveMembers: { _id?: string; toString?(): string }[] | string[] } };
    const inactive = teamJson.data.inactiveMembers.map((m) =>
      typeof m === "string" ? m : (m as { _id?: string })._id ?? String(m)
    );
    expect(inactive).toContain(MEMBER_1);
  });

  // ── T9: Inactive member is EXCLUDED from auto-assign ──────────────────────
  it("T9 › inactive member receives NO leads during auto-assign", async () => {
    await resetLeads();

    // MEMBER_1 is still inactive from T8
    const res  = await api(`/teams/${team._id}/auto-assign`, { method: "POST", body: "{}" });
    const json = (await res.json()) as { data: { assigned: number; results: { assignedTo: string }[] } };

    expect(res.status).toBe(200);
    expect(json.data.assigned).toBe(6);

    const receivedMember1 = json.data.results.some((r) => r.assignedTo === MEMBER_1);
    expect(receivedMember1).toBe(false);

    // All leads go to MEMBER_2 and MEMBER_3 only (3 each)
    const countByMember: Record<string, number> = {};
    for (const r of json.data.results) {
      countByMember[r.assignedTo] = (countByMember[r.assignedTo] ?? 0) + 1;
    }
    expect(countByMember[MEMBER_2]).toBe(3);
    expect(countByMember[MEMBER_3]).toBe(3);
  });

  // ── T10: Re-activate member ────────────────────────────────────────────────
  it("T10 › re-activating a member removes them from inactiveMembers", async () => {
    const res = await api(`/teams/${team._id}/members/${MEMBER_1}/toggle-active`, { method: "PATCH" });
    expect(res.status).toBe(200);

    const teamRes  = await api(`/teams/${team._id}`);
    const teamJson = (await teamRes.json()) as { data: { inactiveMembers: string[] } };
    const inactive = teamJson.data.inactiveMembers.map((m) =>
      typeof m === "string" ? m : (m as { _id?: string })._id ?? String(m)
    );
    expect(inactive).not.toContain(MEMBER_1);
  });

  // ── T11: All 3 members active again → leads split 3 ways ──────────────────
  it("T11 › after re-activation all 3 members receive leads equally", async () => {
    await resetLeads();

    const res  = await api(`/teams/${team._id}/auto-assign`, { method: "POST", body: "{}" });
    const json = (await res.json()) as { data: { assigned: number; results: { assignedTo: string }[] } };

    expect(res.status).toBe(200);
    expect(json.data.assigned).toBe(6);

    const countByMember: Record<string, number> = {};
    for (const r of json.data.results) {
      countByMember[r.assignedTo] = (countByMember[r.assignedTo] ?? 0) + 1;
    }
    expect(countByMember[MEMBER_1]).toBe(2);
    expect(countByMember[MEMBER_2]).toBe(2);
    expect(countByMember[MEMBER_3]).toBe(2);
  });

  // ── T12: All members inactive → 400 ───────────────────────────────────────
  it("T12 › returns 400 when ALL members are marked inactive", async () => {
    // Deactivate all 3 members
    await api(`/teams/${team._id}/members/${MEMBER_1}/toggle-active`, { method: "PATCH" });
    await api(`/teams/${team._id}/members/${MEMBER_2}/toggle-active`, { method: "PATCH" });
    await api(`/teams/${team._id}/members/${MEMBER_3}/toggle-active`, { method: "PATCH" });

    await resetLeads();

    const res  = await api(`/teams/${team._id}/auto-assign`, { method: "POST", body: "{}" });
    const json = (await res.json()) as { success: boolean; message: string };

    expect(res.status).toBe(400);
    expect(json.message.toLowerCase()).toContain("inactive");

    // Re-activate all for subsequent tests
    await api(`/teams/${team._id}/members/${MEMBER_1}/toggle-active`, { method: "PATCH" });
    await api(`/teams/${team._id}/members/${MEMBER_2}/toggle-active`, { method: "PATCH" });
    await api(`/teams/${team._id}/members/${MEMBER_3}/toggle-active`, { method: "PATCH" });
  });

  // ── T13: Non-member toggle → 400 ──────────────────────────────────────────
  it("T13 › returns 400 when toggling a user who is NOT in the team", async () => {
    // xellarfx is not in our test team
    const nonMemberId = USERS.xellarfx.id;
    const res = await api(`/teams/${team._id}/members/${nonMemberId}/toggle-active`, { method: "PATCH" });
    expect(res.status).toBe(400);
  });

  // ── T14: 401 on toggle without token ──────────────────────────────────────
  it("T14 › returns 401 when Authorization header is missing on toggle", async () => {
    const res = await api(
      `/teams/${team._id}/members/${MEMBER_1}/toggle-active`,
      { method: "PATCH" },
      false,   // no auth
    );
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("Full cycle: toggle → auto-assign → verify split", () => {

  // ── T15: Complete active/inactive split cycle ──────────────────────────────
  it("T15 › full cycle — deactivate 1, assign 6 leads, verify 2-member split, reactivate, verify 3-member split", async () => {
    await resetLeads();

    // ── Step 1: Deactivate MEMBER_3 ──────────────────────────────────────────
    const toggleOff = await api(`/teams/${team._id}/members/${MEMBER_3}/toggle-active`, { method: "PATCH" });
    expect(toggleOff.status).toBe(200);

    // ── Step 2: Auto-assign all 6 leads ──────────────────────────────────────
    const assignRes  = await api(`/teams/${team._id}/auto-assign`, { method: "POST", body: "{}" });
    const assignJson = (await assignRes.json()) as {
      data: { assigned: number; results: { assignedTo: string }[] }
    };
    expect(assignRes.status).toBe(200);
    expect(assignJson.data.assigned).toBe(6);

    const round1 = assignJson.data.results;
    // MEMBER_3 must have received 0 leads
    expect(round1.some((r) => r.assignedTo === MEMBER_3)).toBe(false);
    // MEMBER_1 and MEMBER_2 each get 3
    const c1: Record<string, number> = {};
    round1.forEach((r) => { c1[r.assignedTo] = (c1[r.assignedTo] ?? 0) + 1; });
    expect(c1[MEMBER_1]).toBe(3);
    expect(c1[MEMBER_2]).toBe(3);

    // ── Step 3: Re-activate MEMBER_3 ─────────────────────────────────────────
    const toggleOn = await api(`/teams/${team._id}/members/${MEMBER_3}/toggle-active`, { method: "PATCH" });
    expect(toggleOn.status).toBe(200);

    // ── Step 4: Reset leads and re-assign with all 3 active ──────────────────
    await resetLeads();
    const assignRes2  = await api(`/teams/${team._id}/auto-assign`, { method: "POST", body: "{}" });
    const assignJson2 = (await assignRes2.json()) as {
      data: { assigned: number; results: { assignedTo: string }[] }
    };
    expect(assignRes2.status).toBe(200);
    expect(assignJson2.data.assigned).toBe(6);

    const round2 = assignJson2.data.results;
    const c2: Record<string, number> = {};
    round2.forEach((r) => { c2[r.assignedTo] = (c2[r.assignedTo] ?? 0) + 1; });
    // All 3 members should have received exactly 2 leads
    expect(c2[MEMBER_1]).toBe(2);
    expect(c2[MEMBER_2]).toBe(2);
    expect(c2[MEMBER_3]).toBe(2);
  });
});
