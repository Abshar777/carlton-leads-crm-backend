import * as XLSX from "xlsx";
import type { ParsedLead, ExcelParseResult } from "../types/index.js";
import { LeadService } from "./leadService.js";

// Normalize header names to a canonical key
function normalizeHeader(header: string): string {
  return header.trim().toLowerCase();
}

// Map a normalized header to a field name
const HEADER_MAP: Record<string, keyof ParsedLead> = {
  name: "name",
  "full name": "name",
  fullname: "name",
  email: "email",
  "email address": "email",
  phone: "phone",
  "phone number": "phone",
  mobile: "phone",
  "mobile number": "phone",
  contact: "phone",
  source: "source",
  "lead source": "source",
  notes: "notes",
  note: "notes",
  comments: "notes",
  comment: "notes",
};

const leadService = new LeadService();

export class ExcelService {
  async parseFile(buffer: Buffer, mimetype: string): Promise<ExcelParseResult> {
    let workbook: XLSX.WorkBook;

    try {
      workbook = XLSX.read(buffer, { type: "buffer" });
    } catch {
      throw Object.assign(
        new Error("Failed to parse file. Ensure it is a valid xlsx or csv."),
        {
          statusCode: 400,
        },
      );
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      throw Object.assign(new Error("No sheets found in the file"), {
        statusCode: 400,
      });
    }

    const sheet = workbook.Sheets[sheetName];
    // Convert to array of arrays to handle headers manually
    const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
    });

    if (rows.length < 2) {
      return { valid: [], invalid: [] };
    }

    // Row 0 is headers, rows 1+ are data
    const rawHeaders = rows[0] as string[];
    const normalizedHeaders = rawHeaders.map(normalizeHeader);

    // Build field index map
    const fieldIndexMap: Partial<Record<keyof ParsedLead, number>> = {};
    normalizedHeaders.forEach((h, idx) => {
      const field = HEADER_MAP[h];
      if (field && !(field in fieldIndexMap)) {
        fieldIndexMap[field] = idx;
      }
    });

    const valid: ParsedLead[] = [];
    const invalid: ExcelParseResult["invalid"] = [];

    // Process data rows (starting from index 1)
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] as unknown[];
      const rowNumber = i + 1; // 1-indexed, row 1 = headers so data starts at row 2

      const rawData: Record<string, unknown> = {};
      rawHeaders.forEach((h, idx) => {
        rawData[h] = row[idx];
      });

      // Extract fields
      const name =
        fieldIndexMap.name !== undefined
          ? String(row[fieldIndexMap.name] ?? "").trim()
          : "";
      const phone =
        fieldIndexMap.phone !== undefined
          ? String(row[fieldIndexMap.phone] ?? "").trim()
          : "";
      const email =
        fieldIndexMap.email !== undefined
          ? String(row[fieldIndexMap.email] ?? "").trim()
          : undefined;
      const source =
        fieldIndexMap.source !== undefined
          ? String(row[fieldIndexMap.source] ?? "").trim()
          : undefined;
      const notes =
        fieldIndexMap.notes !== undefined
          ? String(row[fieldIndexMap.notes] ?? "").trim()
          : undefined;

      const errors: string[] = [];

      if (!name) {
        errors.push("Name is required");
      }

      if (!phone) {
        errors.push("Phone is required");
      }

      const existingLead = await leadService.getLeadsByPhoneNumber(
        phone.replace("+", ""),
      );

      if (existingLead) {
        errors.push("Lead already exists");
      }

      // Skip completely empty rows
      const allEmpty = rawHeaders.every(
        (_, idx) => !String(row[idx] ?? "").trim(),
      );
      if (allEmpty) continue;

      if (errors.length > 0) {
        invalid.push({ row: rowNumber, data: rawData, errors });
      } else {
        const parsedLead: ParsedLead = {
          name,
          phone:phone.replace("+", ""),
        };

        if (email) parsedLead.email = email;
        if (source) parsedLead.source = source;
        if (notes) parsedLead.notes = notes;

        valid.push(parsedLead);
      }
    }

    return { valid, invalid };
  }
}
