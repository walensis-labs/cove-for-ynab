export interface CategorySnapshot {
  id: string; name: string; group: string; hidden: boolean
  assigned: number; assignedText: string
  activity: number; activityText: string
  available: number; availableText: string
  goalType: string | null; goalTarget: number | null; goalTargetText: string | null
  goalUnderFunded: number | null; goalUnderFundedText: string | null; goalPercentageComplete: number | null
}
export interface ScheduledSnapshot {
  id: string; dateNext: string; frequency: string; amount: number; amountText: string
  payeeName: string | null; categoryName: string | null; memo: string | null
}
export interface Txn {
  id: string; date: string; amount: number; amountText: string; payeeName: string | null; payeeId: string | null
  categoryName: string | null; categoryId: string | null; accountName: string; accountId: string
  memo: string | null; cleared: 'cleared' | 'uncleared' | 'reconciled'; approved: boolean
  flagColor: string | null; transferAccountId: string | null; importId: string | null
  subtransactions?: { amount: number; amountText: string; categoryName: string | null; memo: string | null }[]
}
