import type { ConnectionConfig } from "../types/index.js";
import { listWorkspaceFolder, exportNotebookSource, listNotebooksRecursive } from "../services/databricksClient.js";

/** Lists notebooks and directories under a workspace path. */
export async function list_workspace_folder(connection: ConnectionConfig, path = "/") {
  const entries = await listWorkspaceFolder(connection, path);
  return entries;
}

/** Reads the full source of a notebook at `path`. Returns UTF-8 text. */
export async function read_notebook_source(connection: ConnectionConfig, path: string) {
  const src = await exportNotebookSource(connection, path);
  return src;
}

/** Recursively lists all notebooks under a root path. */
export async function list_notebooks_recursive(connection: ConnectionConfig, root = "/") {
  const notebooks = await listNotebooksRecursive(connection, root);
  return notebooks;
}

/** Simple search that matches notebook path or filename containing `keyword`. */
export async function search_notebooks_by_keyword(connection: ConnectionConfig, rootPath: string, keyword: string) {
  const notebooks = await listNotebooksRecursive(connection, rootPath);
  const needle = keyword.toLowerCase();
  return notebooks.filter((n) => n.path.toLowerCase().includes(needle) || n.name.toLowerCase().includes(needle));
}

export default {
  list_workspace_folder,
  read_notebook_source,
  list_notebooks_recursive,
  search_notebooks_by_keyword
};
