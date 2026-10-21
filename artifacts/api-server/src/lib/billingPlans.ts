// 1 credit = $1 purchasing power. Amounts in smallest currency unit (paise / cents).
export const TOPUP_PACKS: Record<
  string,
  { credits: number; amount_inr: number; amount_usd: number; name: string }
> = {
  small:  { credits: 1,  amount_inr:  9500, amount_usd:  100, name: "$1 Credit Pack"  },
  medium: { credits: 28,  amount_inr: 237500, amount_usd:  2500, name: "$25 Credit Pack"  },
  large:  { credits: 60,  amount_inr: 475000, amount_usd:  5000, name: "$50 Credit Pack"  },
  xl:     { credits: 130, amount_inr: 950000, amount_usd: 10000, name: "$100 Credit Pack" },
};

export const SUBSCRIPTION_TIERS: Record<
  string,
  { credits: number; amount_inr: number; amount_usd: number }
> = {
  starter: { credits: 35,   amount_inr:  275500, amount_usd:  2900 },
  growth:  { credits: 500,  amount_inr: 3790500, amount_usd: 39900 },
  scale:   { credits: 1000, amount_inr: 7590500, amount_usd: 79900 },
};
