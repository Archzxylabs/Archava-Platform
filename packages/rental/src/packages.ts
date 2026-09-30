export interface RentalPackage {
  readonly duration: number // seconds
  readonly durationLabel: string
  readonly defaultPriceBnb: string
  readonly includedMinutes: number
  readonly description: string
}

export const DEMO_PACKAGES: readonly RentalPackage[] = [
  {
    duration: 3600, // 1 hour
    durationLabel: '1 Hour',
    defaultPriceBnb: '0.0005',
    includedMinutes: 60,
    description: '1 hour access to Archava experience & conversational AI avatar.',
  },
  {
    duration: 86400, // 24 hours
    durationLabel: '1 Day',
    defaultPriceBnb: '0.002',
    includedMinutes: 1440,
    description: 'Full day access with extended quota for evaluation and testing.',
  },
  {
    duration: 604800, // 7 days
    durationLabel: '7 Days',
    defaultPriceBnb: '0.01',
    includedMinutes: 10080,
    description: 'Weekly pass for continuous integration, demos, and user trials.',
  },
]
