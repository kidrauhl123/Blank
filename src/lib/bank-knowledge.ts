// 本行知识库：演示银行自己的服务文档。费率、时限、材料都是虚构的演示内容，并且只写 Blank 实际能办的渠道。
// “在本行怎么办”的回答只能引用这里的条目，并注明来源与版本；没有命中的内容不编造。
export const KNOWLEDGE_TOPICS = ["accounts", "cards", "statements", "transfers", "branches", "deposits", "credit", "disputes", "payments", "special", "wealth", "cross-border", "fraud"] as const;
export type KnowledgeTopic = (typeof KNOWLEDGE_TOPICS)[number];

export type KnowledgeEntry = {
  id: string; topic: KnowledgeTopic; title: string; keywords: string[]; body: string;
  document: string; section: string; version: string; effectiveOn: string;
};

const VERSION = "2026.10";
const EFFECTIVE_ON = "2026-10-01";
const entry = (topic: KnowledgeTopic, id: string, title: string, document: string, section: string, keywords: string[], body: string): KnowledgeEntry =>
  ({ id, topic, title, keywords, body, document, section, version: VERSION, effectiveOn: EFFECTIVE_ON });

export const BANK_KNOWLEDGE: KnowledgeEntry[] = [
  entry("accounts", "accounts-open", "开户与实名", "个人账户服务手册", "1.1", ["开户", "实名", "开通账户", "开个户"],
    "个人账户可在 App 或网点开立，需完成实名认证（本人身份证件，并通过人脸或银行卡验证）。同一客户可以开立多个储蓄账户，每个账户都有独立的余额和流水。"),
  entry("accounts", "accounts-freeze", "账户冻结", "特殊情况服务指引", "2.1", ["冻结", "冻结账户", "被冻结", "止付"],
    "账户因可疑交易、司法协助或风险管控被冻结时，仍可查询余额，但不能转出。解冻需本人携带身份证件到网点，按通知要求提供说明材料，结果以银行审核为准。"),
  entry("cards", "card-virtual", "申请虚拟卡", "卡片服务说明", "1.2", ["虚拟卡", "申请卡", "开卡", "办卡"],
    "在 App 的卡片页可以申请虚拟卡：填写卡片名称，本人确认后即时开通，没有实体卡。卡片以尾号显示，每日限额以卡片页显示为准。"),
  entry("cards", "card-lock", "锁卡", "卡片服务说明", "2.1", ["锁卡", "锁定卡", "停用卡", "卡被锁"],
    "在卡片页选择卡片并锁定后，该卡不能消费和取现。锁卡是临时停用，不等于挂失。App 暂不支持解锁，需要解锁请致电 95588 或到网点办理。"),
  entry("cards", "card-loss", "挂失与解挂", "卡片服务说明", "2.2", ["挂失", "遗失", "丢了", "被盗", "解挂"],
    "挂失和解挂暂未在 App 上线。卡片遗失或被盗刷时，请先在卡片页锁卡，再致电 95588 或到网点办理挂失，办理时需带身份证件。"),
  entry("cards", "card-overseas", "境外交易设置", "卡片服务说明", "3.1", ["境外", "海外", "境外刷卡", "境外交易", "境外消费"],
    "卡片信息中会显示是否开通境外交易。App 暂不支持修改境外交易设置，需要开通或关闭请致电 95588 或到网点办理。境外消费提醒暂无单独设置。"),
  entry("statements", "statement-monthly", "账单与明细", "对账单与证明办理指南", "1.1", ["账单", "明细", "流水", "对账单", "月度"],
    "App 的「明细」可查看每月的收入、支出、转账和理财往来，统计按北京时间自然月计算。账面流出包含转账；消费分析只看支出，不含转账和理财。"),
  entry("statements", "statement-paper", "纸质对账单", "对账单与证明办理指南", "1.2", ["纸质", "打印", "寄送", "纸质对账单"],
    "纸质对账单可到网点申请打印，需本人身份证件。App 内生成对账单 PDF 的功能暂未上线。"),
  entry("statements", "cert-deposit", "存款证明", "对账单与证明办理指南", "2.1", ["存款证明", "开证明", "证明文件"],
    "存款证明需本人持身份证件到网点申请，App 暂不支持线上开具。办理时说明用途，证明的有效期以网点出具的文件为准。"),
  entry("statements", "cert-credit", "资信证明", "对账单与证明办理指南", "2.2", ["资信证明", "信用证明", "征信证明"],
    "资信证明用于证明账户往来与信用情况，需到网点办理，App 暂不支持线上生成。办理时需本人身份证件，出具时限以网点公告为准。"),
  entry("transfers", "transfer-domestic", "行内转账", "转账与汇款说明", "1.1", ["转账", "行内", "本行转账", "到账"],
    "本行之间的转账在 App 的转账页面办理，通常实时到账。大额、新收款人或风险较高的转账，会要求你本人确认或完成强验证。"),
  entry("transfers", "transfer-interbank", "跨行转账", "转账与汇款说明", "1.2", ["跨行", "他行", "其他银行", "未到账"],
    "跨行转账一般 2 小时内到账。超过 2 小时未到账，可在「明细」查看状态，并致电 95588 查询。"),
  entry("transfers", "transfer-overseas", "境外汇款", "转账与汇款说明", "2.1", ["境外汇款", "汇款", "国外", "SWIFT", "到账时间", "手续费"],
    "境外汇款需到网点办理，需提供收款人姓名、账号、收款银行名称和 SWIFT 代码。一般 1 至 3 个工作日到账，遇节假日顺延；手续费按金额收取，最低 80 元，最高 300 元。"),
  entry("transfers", "transfer-recall", "转账撤回", "转账与汇款说明", "3.1", ["撤回", "撤销", "退回", "转错"],
    "已经成功的转账，银行不能单方面撤回。转错时请尽快联系收款人协商退回，并致电 95588 请求协助，银行不保证结果。"),
  entry("branches", "channels-overview", "办理渠道", "网点与渠道指南", "1.1", ["渠道", "办理渠道", "电话银行", "网点"],
    "可办理业务的渠道有 App、网页版、电话银行（95588）和网点。App 能办的转账、理财、卡片、取号和换汇预约可以直接在对话里办理；其余业务以网点公告为准。"),
  entry("branches", "branch-queue", "网点取号", "网点与渠道指南", "2.1", ["取号", "排队", "预约取号", "网点取号"],
    "App 可以预约网点取号，选择网点、服务类型（个人业务、换汇、开卡、理财咨询）和营业时间内的时段。到店后凭取号单号办理。"),
  entry("branches", "branch-hours", "营业时间", "网点与渠道指南", "2.2", ["营业时间", "几点开门", "开门", "营业", "周末"],
    "网点营业时间以网点公告为准，节假日可能调整。App 查询的营业状态按北京时间计算。ATM 可以 24 小时取现。"),
  entry("deposits", "deposit-demand", "活期存款", "存款与信贷产品说明", "1.1", ["活期", "随存随取", "活期利息"],
    "活期存款随存随取，按季结息，年利率 0.30%（演示利率，以公告为准）。App 暂不支持开立存款产品，开立和支取定期存款请到网点办理。"),
  entry("deposits", "deposit-fixed", "定期存款", "存款与信贷产品说明", "1.2", ["定期", "定存", "三个月", "一年", "提前支取"],
    "定期存款年利率：3 个月 1.10%，6 个月 1.30%，1 年 1.50%（演示利率，以公告为准）。提前支取按活期利率计息，需到网点办理。"),
  entry("credit", "credit-card-repay", "信用卡还款", "存款与信贷产品说明", "2.1", ["信用卡", "还款", "最低还款", "账单日", "逾期"],
    "信用卡最低还款额为账单金额的 10%。超过最后还款日未还全额，将按日计收罚息。信用卡申请与账单业务请到网点或线上渠道办理，App 暂不支持申请。"),
  entry("credit", "loan-consumer", "消费贷款", "存款与信贷产品说明", "2.2", ["贷款", "消费贷", "借钱", "额度", "利率"],
    "消费贷款额度以审批为准，年化利率区间为 4.8% 至 12%（演示利率）。申请需到网点或线上渠道办理，App 暂不支持申请和放款。"),
  entry("disputes", "dispute-duplicate-charge", "重复扣款", "客户权益与争议处理办法", "1.1", ["重复扣款", "重复扣", "扣了两次", "多扣", "重复付款"],
    "发现同一商户短时间内重复扣款，请保留账单截图和交易凭证，致电 95588 或到网点提交争议申请。银行在 3 个工作日内回复初步结论，最终结果以核查为准。"),
  entry("disputes", "dispute-complaint", "投诉", "客户权益与争议处理办法", "2.1", ["投诉", "意见", "不满", "服务不好", "举报"],
    "可以致电 95588 或到网点投诉，银行在 5 个工作日内给出答复。投诉处理期间账户可以正常使用。"),
  entry("payments", "payroll", "代发工资", "存款与信贷产品说明", "3.1", ["代发", "工资", "发工资", "工资卡"],
    "单位可到网点办理代发工资，个人可到网点查询代发明细。工资到账情况可在「明细」查看。"),
  entry("payments", "bill-payment", "生活缴费", "网点与渠道指南", "3.1", ["缴费", "水费", "电费", "燃气", "物业", "缴纳"],
    "生活缴费的扣款记录可在「明细」查看，类别为生活缴费。新增缴费项目或缴费方式的变更，请以网点或服务渠道公告为准。"),
  entry("special", "special-proxy", "代办", "特殊情况服务指引", "1.1", ["代办", "代理", "他人办", "委托"],
    "他人代办需持本人与代办人的身份证件，以及由本人签署的授权委托书。涉及账户资金的确认，代办人不能替本人完成。"),
  entry("special", "special-inherit", "继承", "特殊情况服务指引", "2.1", ["继承", "去世", "过世", "遗产"],
    "账户持有人去世后，继承人需到网点办理，提供死亡证明、继承公证书或法院判决书，以及继承人身份证件。办理期间账户可能被暂停交易。"),
  entry("special", "special-elderly", "老年人服务", "特殊情况服务指引", "3.1", ["老年人", "老人", "长辈", "助老", "父母"],
    "老年客户可到网点申请人工协助办理，网点会安排专人服务。涉及转账、理财等资金操作，仍需本人确认，银行不会代为确认。"),
  entry("wealth", "wealth-risk", "风险测评", "理财服务说明", "1.1", ["风险测评", "测评", "风险等级"],
    "购买理财前需先完成风险测评，测评结果有效期 12 个月，过期需重新测评。测评由本人作答，不能由他人代选。"),
  entry("wealth", "wealth-note", "收益与风险说明", "理财服务说明", "2.1", ["收益", "历史收益", "净值", "亏损", "本金"],
    "历史收益不代表未来表现，净值可能下跌，理财产品存在本金损失的风险。App 中的近 30 天变化只是历史数据，不是承诺或预测。"),
  entry("cross-border", "cb-fees", "境外刷卡手续费", "跨境金融服务指引", "1.1", ["境外消费", "境外刷卡", "手续费", "外币", "折算"],
    "境外刷卡按交易金额收取 1.5% 的手续费，外币按银行卡组织的折算汇率换算为人民币。具体以扣款时的账单为准。"),
  entry("cross-border", "cb-fx-booking", "换汇预约", "跨境金融服务指引", "2.1", ["换汇", "换外币", "兑换", "预约换汇", "外汇"],
    "可在 App 预约到网点换汇，选择币种、金额、网点和日期。预约时显示的参考折算金额仅供参考，到店按当时挂牌价成交。预约本身不扣款，也不改变账户余额。"),
  entry("cross-border", "cb-reference-rate", "参考汇率", "跨境金融服务指引", "2.2", ["参考汇率", "汇率", "中间价", "牌价"],
    "App 显示的参考汇率为中间价，仅供参考，不是成交价。实际成交价以网点当时的挂牌价为准。"),
  entry("cross-border", "cb-allowance", "个人年度购汇额度", "跨境金融服务指引", "3.1", ["5万美元", "五万美元", "额度", "年度", "购汇", "便利化"],
    "根据外汇管理规定，个人每年便利化购汇额度为等值 5 万美元。超过额度需按规定提交材料，以银行审核为准。本说明不构成法律或税务建议。"),
  entry("fraud", "fraud-hotline", "反诈专线", "反诈服务说明", "1.1", ["反诈", "96110", "诈骗", "被骗", "安全账户", "冒充"],
    "遇到冒充客服、公检法、要求转入“安全账户”、刷单、交保证金等情形，请立即停止转账，并拨打 96110 反诈专线咨询。"),
  entry("fraud", "fraud-code", "验证码与密码", "反诈服务说明", "1.2", ["验证码", "动态码", "密码", "索要"],
    "验证码和密码只能由本人输入，不能告诉任何人。银行工作人员不会索要验证码或密码。"),
  entry("fraud", "fraud-guard", "反诈守护", "反诈服务说明", "2.1", ["守护", "拦截", "暂缓", "24小时", "可疑转账"],
    "发起可疑转账时，Blank 会暂缓并给出拦截卡，说明可疑的具体原因，并询问几个关键问题。你可以取消，或选择 24 小时后再办；不会因为一次误报锁死你的钱。"),
];

// 命中规则：问题里包含某个条目的关键词，或者问题里的两字片段（单字问题取该字）有一半以上出现在条目里。
// 常用词（如“银行”）不单独命中，避免把无关条目带出来。
const bigrams = (text: string) => {
  const compact = text.replace(/\s+/g, "");
  if (compact.length <= 1) return new Set(compact ? [compact] : []);
  const grams = new Set<string>();
  for (let index = 0; index < compact.length - 1; index++) grams.add(compact.slice(index, index + 2));
  return grams;
};

export function searchBankKnowledge(question: string, topic?: KnowledgeTopic, limit = 3) {
  const query = question.trim();
  const grams = bigrams(query);
  if (!grams.size) return [];
  const hits = BANK_KNOWLEDGE.filter(item => !topic || item.topic === topic).map(item => {
    const haystack = [item.title, ...item.keywords, item.body].join("");
    const matched = [...grams].filter(gram => haystack.includes(gram)).length;
    const keywordHits = item.keywords.filter(keyword => query.includes(keyword)).length;
    return { item, coverage: matched / grams.size, keywordHits };
  }).filter(hit => hit.keywordHits > 0 || hit.coverage >= 0.5)
    .sort((a, b) => b.keywordHits - a.keywordHits || b.coverage - a.coverage || a.item.id.localeCompare(b.item.id));
  return hits.slice(0, limit).map(({ item }) => ({
    id: item.id, topic: item.topic, title: item.title, body: item.body,
    source: `${item.document} ${item.section}`, version: item.version, effectiveOn: item.effectiveOn,
  }));
}
