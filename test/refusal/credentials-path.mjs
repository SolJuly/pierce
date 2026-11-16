/**
 * 凭据文件路径解析。
 *
 * 不硬编码任何人的家目录：优先 DSH_CREDENTIALS，其次 $DSH_HOME/.credentials.yaml，
 * 最后退回 ~/.dsh/.credentials.yaml。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CREDENTIALS_FILE =
  process.env.DSH_CREDENTIALS ||
  path.join(process.env.DSH_HOME || path.join(os.homedir(), ".dsh"), ".credentials.yaml");

/** 读一个 KEY=value 形式的凭据；找不到返回 undefined。 */
export function readCredential(name, file = CREDENTIALS_FILE) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const m = text.match(new RegExp(`${name}:\\s*(\\S+)`));
    return m?.[1];
  } catch {
    return undefined;
  }
}
