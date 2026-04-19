export interface ToolConfig {
  id: string;
  name: string;
  prefixes: string[];
  icon: string;
}

export interface AnnotationGroup {
  tool: ToolConfig | null;
  annotations: Record<string, string>;
  shortKeys: Record<string, string>;
}

export interface ToolGroupProps {
  annotations: Record<string, string>;
  toolConfig: ToolConfig;
  shortKeys: Record<string, string>;
}
