import {
  ArrowDownLeft, ArrowUpRight, ArrowLeftRight, BookOpen, BriefcaseBusiness,
  CirclePlay, RotateCcw, ShoppingBag, TrainFront, TrendingUp, Utensils,
  Wallet, Zap, type LucideIcon,
} from "lucide-react";

const categoryIcons: Record<string, LucideIcon> = {
  餐饮: Utensils,
  购物: ShoppingBag,
  交通: TrainFront,
  订阅: CirclePlay,
  生活缴费: Zap,
  教育: BookOpen,
  转账: ArrowLeftRight,
  理财: TrendingUp,
  模拟理财: TrendingUp,
  工资: BriefcaseBusiness,
  薪资: BriefcaseBusiness,
  收入: Wallet,
  经营收入: Wallet,
  入金: Wallet,
  退款: RotateCcw,
};

export function TransactionCategoryIcon({ category, merchant, incoming }: {
  category: string;
  merchant: string;
  incoming: boolean;
}) {
  const Icon = incoming && /退款|退货/.test(`${category} ${merchant}`)
    ? RotateCcw
    : category === "收入" && /工资|薪资/.test(merchant)
      ? BriefcaseBusiness
      : categoryIcons[category.trim()] ?? (incoming ? ArrowDownLeft : ArrowUpRight);
  return <Icon aria-hidden="true" focusable="false" strokeWidth={1.8} />;
}
