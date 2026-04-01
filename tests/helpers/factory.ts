/**
 * Test Data Factory
 * ─────────────────────────────────────────────────────────────────────────────
 * Creates and destroys test-specific data via the real API.
 * Every created resource is tracked so afterAll can clean up safely.
 */

import { api } from "./auth.js";
import { TEST_PREFIX } from "../config.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreatedTeam {
  _id:            string;
  name:           string;
  leaders:        string[];
  members:        string[];
  inactiveMembers: string[];
}

export interface CreatedLead {
  _id:        string;
  name:       string;
  phone:      string;
  assignedTo: string | null;
  status:     string;
  team:       string | null;
}

// ─── Team Factory ─────────────────────────────────────────────────────────────

export async function createTestTeam(opts: {
  name?:    string;
  leaders?: string[];
  members?: string[];
}): Promise<CreatedTeam> {
  const res = await api("/teams", {
    method: "POST",
    body:   JSON.stringify({
      name:    opts.name ?? `${TEST_PREFIX} Auto-Assign Team`,
      leaders: opts.leaders ?? [],
      members: opts.members ?? [],
      status:  "active",
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`createTestTeam failed ${res.status}: ${body}`);
  }

  const json = (await res.json()) as { data: CreatedTeam };
  return json.data;
}

export async function deleteTestTeam(teamId: string): Promise<void> {
  await api(`/teams/${teamId}`, { method: "DELETE" });
}

// ─── Lead Factory ─────────────────────────────────────────────────────────────

let phoneCounter = 9000000000;

export async function createTestLead(opts: {
  name?:      string;
  teamId?:    string;
  assignedTo?: string | null;
} = {}): Promise<CreatedLead> {
  phoneCounter += 1;

  // Step 1: create the lead
  const body: Record<string, unknown> = {
    name:   opts.name ?? `${TEST_PREFIX} Lead ${phoneCounter}`,
    phone:  String(phoneCounter),
    source: "Test Suite",
    status: "new",
  };

  const res = await api("/leads", {
    method: "POST",
    body:   JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`createTestLead failed ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { data: CreatedLead };
  const lead = json.data;

  // Step 2: assign to team if specified
  if (opts.teamId) {
    const teamRes = await api(`/leads/${lead._id}/team`, {
      method: "PATCH",
      body:   JSON.stringify({ teamId: opts.teamId }),
    });
    if (!teamRes.ok) {
      const text = await teamRes.text();
      throw new Error(`assignLeadToTeam failed ${teamRes.status}: ${text}`);
    }
  }

  // Step 3: unassign if caller wants assignedTo: null
  if (opts.assignedTo === null) {
    const updateRes = await api(`/leads/${lead._id}`, {
      method: "PUT",
      body:   JSON.stringify({ assignedTo: null }),
    });
    if (!updateRes.ok) {
      const text = await updateRes.text();
      throw new Error(`unassignLead failed ${updateRes.status}: ${text}`);
    }
    const updated = (await updateRes.json()) as { data: CreatedLead };
    return { ...updated.data, team: opts.teamId ?? null };
  }

  return { ...lead, team: opts.teamId ?? null };
}

export async function deleteTestLead(leadId: string): Promise<void> {
  await api(`/leads/${leadId}`, { method: "DELETE" });
}

export async function deleteTestLeads(leadIds: string[]): Promise<void> {
  await Promise.allSettled(leadIds.map(deleteTestLead));
}

// ─── Lead state helpers ───────────────────────────────────────────────────────

/** Re-fetch a lead and return its current assignedTo */
export async function getLeadAssignee(leadId: string): Promise<string | null> {
  const res  = await api(`/leads/${leadId}`);
  const json = (await res.json()) as { data: { assignedTo: { _id?: string } | string | null } };
  const at   = json.data?.assignedTo;
  if (!at) return null;
  if (typeof at === "string") return at;
  return at._id ?? null;
}

/** Reset a lead back to unassigned (for re-use across test cases) */
export async function unassignLead(leadId: string): Promise<void> {
  await api(`/leads/${leadId}`, {
    method: "PUT",
    body:   JSON.stringify({ assignedTo: null, status: "new" }),
  });
}
