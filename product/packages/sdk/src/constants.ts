export const Duration = {
  Weekly: 7,
  Monthly: 30,
} as const;

export type Duration = (typeof Duration)[keyof typeof Duration];
export const DURATIONS = [Duration.Weekly, Duration.Monthly] as const;
export const DEFAULT_DURATION = Duration.Weekly;
