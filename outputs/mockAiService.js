(function () {
  const LANG = {
    tr: {
      summary: "Analiz tamamlandı. Verilen içerik ürün, pazarlama ve operasyon açısından okunabilir içgörülere ayrıldı.",
      noLocRisk: "Bu mock analizde büyük bir lokalizasyon riski bulunmadı.",
      reportTitle: "Haftalık Çalışma Raporu",
      assistantTitle: "PlayScope AI yanıtı"
    },
    en: {
      summary: "Analysis completed. The provided content was organized into product, marketing, and operations insights.",
      noLocRisk: "No major localization risk detected in this mock analysis.",
      reportTitle: "Weekly Work Report",
      assistantTitle: "PlayScope AI response"
    },
    zh: {
      summary: "分析完成。输入内容已整理为产品、营销和运营洞察。",
      noLocRisk: "此模拟分析未发现明显本地化风险。",
      reportTitle: "周报",
      assistantTitle: "PlayScope AI 回复"
    }
  };

  const POSITIVE = ["good", "great", "fun", "love", "smooth", "beautiful", "nice", "addictive", "iyi", "guzel", "güzel", "eglenceli", "eğlenceli", "seviyorum", "harika", "akıcı", "好", "喜欢", "流畅"];
  const NEGATIVE = ["bad", "crash", "lag", "bug", "slow", "expensive", "boring", "pay", "p2w", "kötü", "kotu", "kas", "don", "hata", "para", "pahalı", "sıkıcı", "崩溃", "卡", "贵"];

  function clean(value) {
    return String(value || "").trim();
  }

  function lower(value) {
    return clean(value).toLowerCase();
  }

  function splitLines(value) {
    return clean(value).split(/\r?\n+/).map((line) => line.trim()).filter(Boolean);
  }

  function hasAny(text, words) {
    const source = lower(text);
    return words.some((word) => source.includes(lower(word)));
  }

  function percent(value, total) {
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
  }

  function firstExample(lines, words) {
    return lines.find((line) => hasAny(line, words)) || lines[0] || "";
  }

  function listFromText(value) {
    return splitLines(value).flatMap((line) => line.split(/[;,]/)).map((item) => item.trim()).filter(Boolean);
  }

  function titleCase(value) {
    return clean(value).replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function languagePack(lang) {
    return LANG[lang] || LANG.en;
  }

  function analyzeReviews(input = {}) {
    const lang = input.uiLanguage || "en";
    const pack = languagePack(lang);
    const reviews = splitLines(input.reviews);
    const gameName = clean(input.gameName) || "Untitled Game";
    let positiveCount = 0;
    let negativeCount = 0;
    reviews.forEach((review) => {
      if (hasAny(review, POSITIVE)) positiveCount += 1;
      if (hasAny(review, NEGATIVE)) negativeCount += 1;
    });
    const neutralCount = Math.max(0, reviews.length - positiveCount - negativeCount);
    const complaintRules = [
      ["Performance / lag", ["lag", "slow", "kas", "don", "卡"], "High"],
      ["Bugs / crashes", ["crash", "bug", "hata", "崩溃"], "High"],
      ["Payment / monetization", ["pay", "p2w", "expensive", "para", "pahalı", "贵"], "Medium"],
      ["Localization issues", ["translation", "localization", "çeviri", "ceviri", "翻译"], "Medium"],
      ["Gameplay feedback", ["boring", "repeat", "grind", "sıkıcı", "tekrar"], "Medium"],
      ["Event feedback", ["event", "reward", "ödül", "odul", "活动"], "Low"]
    ];
    const topComplaints = complaintRules
      .filter(([, words]) => reviews.some((review) => hasAny(review, words)))
      .slice(0, 4)
      .map(([category, words, severity]) => ({
        category,
        severity,
        explanation: `${category} signals appear in player comments and should be checked before the next campaign beat.`,
        example: firstExample(reviews, words)
      }));
    if (!topComplaints.length) {
      topComplaints.push({
        category: "General feedback",
        severity: "Low",
        explanation: "No strong complaint cluster was detected; monitor future reviews for repeated patterns.",
        example: reviews[0] || "No review example provided."
      });
    }
    const topPraises = [
      {
        category: "Core appeal",
        explanation: "Positive wording suggests the base gameplay promise can be used in marketing copy.",
        example: firstExample(reviews, POSITIVE) || reviews[0] || "No praise example provided."
      }
    ];
    const locRisks = hasAny(reviews.join(" "), ["translation", "localization", "çeviri", "ceviri", "翻译"])
      ? [{ language: input.reviewLanguage || "Mixed", issue: "Players mention translation or wording quality.", suggestion: "Review UI text and event copy with native game localization QA." }]
      : [];
    return {
      summary: `${gameName}: ${pack.summary}`,
      sentiment: {
        positive: percent(positiveCount, reviews.length || 1),
        neutral: percent(neutralCount, reviews.length || 1),
        negative: percent(negativeCount, reviews.length || 1)
      },
      topComplaints,
      topPraises,
      productActions: [
        "Group repeated review issues by platform and version before prioritizing fixes.",
        "Check early funnel and session stability if performance complaints repeat.",
        "Tag review themes weekly so product and community teams use the same language."
      ],
      marketingActions: [
        "Use praised features as ad copy proof points.",
        "Avoid campaign claims that conflict with repeated player complaints.",
        "Turn common player language into community post wording."
      ],
      localizationRisks: locRisks,
      executiveSummary: `${reviews.length || 0} review line(s) analyzed for ${input.platform || "selected platform"} in ${input.market || "selected market"}. ${topComplaints[0].category} is the first theme to monitor.`
    };
  }

  function checkLocalization(input = {}) {
    const source = clean(input.sourceText);
    const current = clean(input.currentTranslation);
    const context = clean(input.contextType) || "UI";
    const target = clean(input.targetLanguage) || "Turkish";
    const terms = listFromText(input.terminology);
    let score = 88;
    if (!source || !current) score -= 35;
    if (current.length > source.length * 1.8 && context === "UI") score -= 12;
    if (hasAny(current, ["development", "solution", "progress"]) && !hasAny(source, ["development", "solution", "progress"])) score -= 8;
    if (terms.length && !terms.some((term) => hasAny(current, [term.split(/[=:]/).pop() || term]))) score -= 5;
    const longRisk = context === "UI" && current.length > 28 ? "Slightly long" : "Safe";
    const verdict = score >= 85 ? "Good for use" : score >= 70 ? "Needs review before publishing" : "Problematic";
    return {
      score: Math.max(0, Math.min(100, score)),
      verdict,
      meaningAccuracy: {
        status: score >= 75 ? "Good" : "Needs review",
        explanation: "Meaning appears mostly preserved based on source and current translation length/signals."
      },
      naturalness: {
        status: score >= 82 ? "Good" : "Needs improvement",
        explanation: target === "Turkish" ? "Prefer natural Turkish game wording over literal phrasing." : "Keep wording natural for the target audience."
      },
      uiLengthRisk: {
        status: longRisk,
        explanation: longRisk === "Safe" ? "The text looks safe for most UI placements." : "Consider a shorter UI variant."
      },
      terminology: {
        status: terms.length ? "Needs review" : "Consistent",
        issues: terms.length ? ["Check established terminology against the final in-game glossary."] : []
      },
      toneStyle: {
        status: context,
        explanation: "Tone should match the selected game context and avoid adding unsupported concepts."
      },
      culturalRisk: {
        status: "Low",
        explanation: "No obvious sensitive cultural wording was detected in this mock QA."
      },
      suggestedTranslation: current,
      explanation: "The suggestion keeps the original meaning and focuses on clarity, brevity, and game-context consistency."
    };
  }

  function generateCampaignIdeas(input = {}) {
    const game = clean(input.gameName) || "the game";
    const genre = clean(input.genre) || "RPG";
    const region = clean(input.region) || "Turkey";
    const goal = clean(input.goal) || "Launch";
    const channels = input.channels && input.channels.length ? input.channels : ["TikTok", "YouTube", "Influencer/KOL"];
    return {
      campaignName: `${titleCase(game)} ${titleCase(goal)} Sprint`,
      concept: `Position ${game} as a ${genre} experience built around community, progression, and a clear reason to play now in ${region}.`,
      audienceInsight: `${region} players respond better when the promise is specific: what they can do, who they can play with, and what they can earn.`,
      creativeAngle: genre.match(/mmo|rpg/i) ? "Guild/team play, class fantasy, comeback rewards" : "Fast hook, visible reward, clear progression",
      socialIdeas: channels.map((channel) => ({
        channel,
        idea: `${channel} short-form concept for ${goal}`,
        execution: "Open with the strongest gameplay promise, show reward/progression, close with one direct CTA."
      })),
      kolIdeas: [
        "Use creators for general campaign concepts only; keep this separate from the existing influencer database.",
        "Prepare creator briefs with do/don't copy, gameplay proof points, and local language examples."
      ],
      inGameEventIdeas: [
        "New player welcome missions",
        "Guild/community milestone rewards",
        "Comeback login streak"
      ],
      localizationSuggestions: [
        "Use natural local wording instead of forced slang.",
        "Avoid overpromising rewards or pay-to-win signals.",
        region.match(/mena|gulf|saudi|uae|qatar/i) ? "Avoid gambling/alcohol references and check culturally sensitive visuals." : "Check local calendar moments before using holiday messaging."
      ],
      riskNotes: [
        "Avoid misleading gameplay ads.",
        "Do not imply rewards that are not actually available.",
        "Review final copy with local market context."
      ],
      adCopies: {
        headlines: ["Build your legend today", "Join the next server rush", "Play together, win bigger"],
        bodyTexts: ["Start strong, grow fast, and claim rewards with your team.", "A new adventure is ready. Gather your allies and enter the fight.", "Progress every day with events, rewards, and community challenges."],
        pushNotifications: ["Your team is waiting.", "New rewards are live.", "Come back and claim today's bonus."]
      }
    };
  }

  function reportLabels(language) {
    if (language === "Chinese") return ["本周工作总结", "下周工作计划", "当前问题与风险", "需要支持事项"];
    if (language === "Turkish") return ["Haftalık İş Özeti", "Gelecek Hafta Planı", "Mevcut Sorunlar ve Riskler", "Gerekli Destek"];
    return ["Weekly Work Summary", "Next Week Plan", "Current Issues and Risks", "Support Needed"];
  }

  function generateWeeklyReport(input = {}) {
    const language = clean(input.language) || "English";
    const labels = reportLabels(language);
    const completed = splitLines(input.completedTasks);
    const ongoing = splitLines(input.ongoingTasks);
    const next = splitLines(input.nextWeekPriorities);
    const blockers = splitLines(input.blockers);
    return {
      language,
      title: languagePack(language === "Turkish" ? "tr" : language === "Chinese" ? "zh" : "en").reportTitle,
      sections: [
        { heading: labels[0], items: completed.length ? completed : ["No completed tasks were provided."] },
        { heading: labels[1], items: next.length ? next : ongoing.length ? ongoing : ["No next-week priorities were provided."] },
        { heading: labels[2], items: blockers.length ? blockers : ["No major blockers were reported."] },
        { heading: labels[3], items: blockers.length ? ["Clarify priorities and missing materials where needed."] : ["No special support request at this stage."] }
      ],
      risks: blockers,
      supportNeeded: blockers.length ? ["Decision support for blocker resolution"] : []
    };
  }

  function generateChatResponse(input = {}) {
    const message = clean(input.message);
    const source = lower(message);
    let mode = "general";
    if (/review|yorum|评价/.test(source)) mode = "review";
    if (/localization|translation|çeviri|ceviri|本地化|翻译/.test(source)) mode = "localization";
    if (/campaign|kampanya|营销/.test(source)) mode = "campaign";
    if (/weekly report|report|rapor|周报/.test(source)) mode = "report";
    const bullets = {
      review: ["Paste review lines into AI Review Analyzer.", "Ask for complaint clusters, praise points, and action items.", "Separate product issues from marketing insights."],
      localization: ["Share source, current translation, context, and terminology.", "Check meaning first, then tone and UI length.", "Use short variants for UI placements."],
      campaign: ["Define market, goal, budget, and channels.", "Start from audience insight before ad copy.", "Keep KOL ideas separate from the influencer database."],
      report: ["List completed work, blockers, and next priorities.", "Choose output language and style.", "Keep claims realistic and based on your notes."],
      general: ["Tell me the task type: review, localization, campaign, or report.", "Add project context if you want sharper output.", "Use the dedicated AI modules for structured results."]
    }[mode];
    return {
      role: "assistant",
      title: languagePack(input.uiLanguage || "en").assistantTitle,
      summary: `I can help with ${mode} work in a structured way.`,
      bullets,
      suggestedNextActions: bullets.slice(0, 2)
    };
  }

  window.MockAiService = {
    analyzeReviews,
    checkLocalization,
    generateCampaignIdeas,
    generateWeeklyReport,
    generateChatResponse
  };
})();
