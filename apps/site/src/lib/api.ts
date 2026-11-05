// The public directory API. Read in the browser, so the site stays static.
export const API = (import.meta.env.PUBLIC_API_URL as string | undefined) || '/api/v1';

export interface Summary {
  owner: string;
  name: string;
  site: string;
  description: string;
  version: number;
  installs: number;
  updated_at: string;
}

export interface Step {
  n: number;
  action: string;
  label: string;
  url?: string;
  value?: string;
  pause?: string;
}

export interface Detail extends Summary {
  meta: { params?: Record<string, { type: string; description?: string }>; pauses?: number[]; secrets?: string[]; returns?: string };
  body: string;
  steps: Step[];
}
