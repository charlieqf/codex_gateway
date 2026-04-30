import type { DatabaseSync } from "node:sqlite";
import type {
  ListSubjectsInput,
  Subject,
  SubjectState
} from "@codex-gateway/core";
import { subjectColumns } from "./columns.js";
import { rowToSubject } from "./row-mappers.js";
import type { UpdateSubjectInput } from "./types.js";

export function upsert(db: DatabaseSync, subject: Subject): void {
  // Bootstrap upsert preserves existing state so credential setup cannot reactivate disabled users.
  db.prepare(
    `INSERT INTO subjects (id, label, name, phone_number, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       label = excluded.label,
       name = COALESCE(excluded.name, subjects.name),
       phone_number = COALESCE(excluded.phone_number, subjects.phone_number)`
  ).run(
    subject.id,
    subject.label,
    subject.name ?? null,
    subject.phoneNumber ?? null,
    subject.state,
    subject.createdAt.toISOString()
  );
}

export function get(db: DatabaseSync, id: string): Subject | null {
  const row = db.prepare(`SELECT ${subjectColumns} FROM subjects WHERE id = ?`).get(id);
  return row ? rowToSubject(row) : null;
}

export function list(db: DatabaseSync, input: ListSubjectsInput = {}): Subject[] {
  const includeArchived = input.includeArchived ?? true;
  const rows = input.state
    ? db
        .prepare(
          `SELECT ${subjectColumns}
           FROM subjects
           WHERE state = ?
             AND (? = 1 OR state != 'archived')
           ORDER BY id`
        )
        .all(input.state, includeArchived ? 1 : 0)
    : db
        .prepare(
          `SELECT ${subjectColumns}
           FROM subjects
           WHERE (? = 1 OR state != 'archived')
           ORDER BY id`
        )
        .all(includeArchived ? 1 : 0);

  return rows.map(rowToSubject);
}

export function update(
  db: DatabaseSync,
  id: string,
  input: UpdateSubjectInput
): Subject | null {
  db.prepare(
    `UPDATE subjects
     SET label = CASE WHEN ? = 1 THEN ? ELSE label END,
         name = CASE WHEN ? = 1 THEN ? ELSE name END,
         phone_number = CASE WHEN ? = 1 THEN ? ELSE phone_number END
     WHERE id = ?`
  ).run(
    input.label === undefined ? 0 : 1,
    input.label ?? null,
    input.name === undefined ? 0 : 1,
    input.name ?? null,
    input.phoneNumber === undefined ? 0 : 1,
    input.phoneNumber ?? null,
    id
  );

  return get(db, id);
}

export function setState(
  db: DatabaseSync,
  id: string,
  state: SubjectState
): Subject | null {
  db.prepare(
    `UPDATE subjects
     SET state = ?
     WHERE id = ?`
  ).run(state, id);

  return get(db, id);
}
