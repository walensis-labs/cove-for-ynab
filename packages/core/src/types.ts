export interface CategorySnapshot {
  id: string; name: string; group: string; hidden: boolean
  assigned: number; activity: number; available: number
  goalType: string | null; goalTarget: number | null
  goalUnderFunded: number | null; goalPercentageComplete: number | null
}
export interface ScheduledSnapshot {
  id: string; dateNext: string; frequency: string; amount: number
  payeeName: string | null; categoryName: string | null; memo: string | null
}
export interface Txn {
  id: string; date: string; amount: number; payeeName: string | null; payeeId: string | null
  categoryName: string | null; categoryId: string | null; accountName: string; accountId: string
  memo: string | null; cleared: 'cleared' | 'uncleared' | 'reconciled'; approved: boolean
  flagColor: string | null; transferAccountId: string | null; importId: string | null
  subtransactions?: { amount: number; categoryName: string | null; memo: string | null }[]
}
