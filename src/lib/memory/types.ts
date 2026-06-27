export type NodeType = "concept" | "experience" | "project" | "people" | "personality";
export type NodeStatus = "active" | "deprecated";

export interface MemoryNode {
  id: string;
  type: NodeType;
  domain: string;
  tags: string[];
  related: string[];
  backlinks: string[];
  priority: number;
  access_count: number;
  last_accessed: string;
  recall_conditions?: string[];
  status: NodeStatus;
  superseded_by?: string;
  title: string;
  content: string;
}

export interface NodeMeta {
  path: string;
  type: NodeType;
  tags: string[];
  links: string[];
  backlinks: string[];
  priority: number;
  access_count: number;
  last_accessed: string;
  status: NodeStatus;
  superseded_by?: string;
}

export interface MemoryIndex {
  nodes: Record<string, NodeMeta>;
}

export interface NodeFilter {
  types?: NodeType[];
  tags?: string[];
  status?: NodeStatus;
  limit?: number;
}
