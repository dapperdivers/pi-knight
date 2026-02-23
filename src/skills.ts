import fs from "node:fs/promises";
import path from "node:path";
import { log } from "./logger.js";

export interface SkillEntry {
  name: string;
  description: string;
  path: string;
  category: string;
}

export type SkillCatalog = SkillEntry[];

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const fm = match[1]!;
  const nameMatch = fm.match(/^name:\s*(.+)$/m);
  const descMatch = fm.match(/^description:\s*(.+)$/m);
  return {
    name: nameMatch?.[1]?.trim().replace(/^["']|["']$/g, ""),
    description: descMatch?.[1]?.trim().replace(/^["']|["']$/g, ""),
  };
}

async function walkForSkills(dir: string, depth: number, results: string[], seen: Set<string>): Promise<void> {
  if (depth > 8) return;
  // Skip .git directories
  if (path.basename(dir) === ".git") return;

  // Resolve symlinks to avoid duplicates
  let realDir: string;
  try {
    realDir = await fs.realpath(dir);
  } catch {
    return;
  }
  if (seen.has(realDir)) return;
  seen.add(realDir);

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // Skip dotfiles/dotdirs
    const full = path.join(dir, entry.name);
    if (entry.name === "SKILL.md" || entry.name === "skill.md") {
      results.push(full);
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      await walkForSkills(full, depth + 1, results, seen);
    }
  }
}

export async function discoverSkills(
  skillCategories: string[],
  skillsDir = "/skills",
  retries = 5,
): Promise<SkillCatalog> {
  // Retry to handle git-sync race at startup
  let skillFiles: string[] = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    skillFiles = [];
    await walkForSkills(skillsDir, 0, skillFiles, new Set());
    if (skillFiles.length > 0) break;
    if (attempt < retries) {
      log.info("No skills found, waiting for git-sync...", { attempt: attempt + 1, retries });
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  const catalog: SkillCatalog = [];
  const allowedCategories = new Set([...skillCategories, "shared"]);

  for (const filePath of skillFiles) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const { name, description } = parseFrontmatter(content);

      // Derive category from path segments — look for known category names
      // Git-sync creates: /skills/roundtable-arsenal/skills/security/opencti-intel/SKILL.md
      // Or direct: /skills/security/opencti-intel/SKILL.md
      // Or shared: /skills/roundtable-arsenal/shared/nats-comms/SKILL.md
      const segments = filePath.split(path.sep);
      let category = "unknown";
      for (const seg of segments) {
        if (allowedCategories.has(seg)) {
          category = seg;
          break;
        }
      }

      // If no match found, try the directory immediately above SKILL.md's parent
      if (category === "unknown") {
        const rel = path.relative(skillsDir, filePath);
        const parts = rel.split(path.sep);
        // Walk parts looking for a "skills" dir, take the next segment as category
        for (let i = 0; i < parts.length - 1; i++) {
          if (parts[i] === "skills" && i + 1 < parts.length) {
            category = parts[i + 1]!;
            break;
          }
        }
      }

      if (category !== "unknown" && !allowedCategories.has(category)) continue;

      catalog.push({
        name: name ?? path.basename(path.dirname(filePath)),
        description: description ?? "",
        path: filePath,
        category,
      });
    } catch {
      log.warn("Failed to read skill file", { path: filePath });
    }
  }

  log.info("Skills discovered", { count: catalog.length, categories: [...allowedCategories] });
  return catalog;
}

export async function loadSkill(skillPath: string): Promise<string> {
  return fs.readFile(skillPath, "utf-8");
}
