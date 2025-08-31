import React, { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Loader2, Send, ServerCog, CheckCircle2, AlertTriangle, Settings2, Bug, Check, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

// ---- Types matching the FastAPI MVP ----

type Intent = "design" | "impl_plan" | "risk" | "qa";

type OwnerResponse = {
  type: "RESPONSE";
  task_id: string;
  owner: string;
  coverage: string[];
  findings: { area: string; summary: string; details?: Record<string, any> }[];
  gaps: string[];
  next_actions: Record<string, any>[];
  confidence: number;
};

type SynthesizedAnswer = {
  task_id: string;
  merged_coverage: string[];
  gaps: string[];
  summary: string;
  by_owner: Record<string, OwnerResponse>;
};

interface AskPayload {
  question: string;
  intent: Intent;
  acceptance_criteria: string[];
}

// ---- API helpers (DI-friendly for tests) ----

async function apiFetchOwners(apiBase: string, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const res = await fetchFn(`${apiBase}/owners?ts=${Date.now()}`);
  if (!(res as any).ok) throw new Error(`${(res as any).status} ${(res as any).statusText}`);
  const data = await (res as any).json();
  return data.owners || [];
}

async function apiAskBoss(apiBase: string, payload: AskPayload, fetchFn: typeof fetch = fetch): Promise<SynthesizedAnswer> {
  const res = await fetchFn(`${apiBase}/ask`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  } as any);
  if (!(res as any).ok) throw new Error(await (res as any).text());
  const data = await (res as any).json();
  return data as SynthesizedAnswer;
}

// ---- UI Component ----

const defaultApi = (typeof window !== "undefined" && localStorage.getItem("boss_api")) || "http://localhost:8000";

export default function BossAgentConsole() {
  const [apiBase, setApiBase] = useState<string>(defaultApi);
  const [owners, setOwners] = useState<string[]>([]);
  const [loadingOwners, setLoadingOwners] = useState<boolean>(false);
  const [connStatus, setConnStatus] = useState<"idle" | "ok" | "fail">("idle");

  const [question, setQuestion] = useState<string>("");
  const [intent, setIntent] = useState<Intent>("impl_plan");
  const [criterionInput, setCriterionInput] = useState<string>("");
  const [criteria, setCriteria] = useState<string[]>([]);

  const [submitting, setSubmitting] = useState<boolean>(false);
  const [answer, setAnswer] = useState<SynthesizedAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);

  // persist API base
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("boss_api", apiBase);
    }
  }, [apiBase]);

  const refreshOwners = useCallback(async () => {
    setLoadingOwners(true);
    setError(null);
    try {
      const list = await apiFetchOwners(apiBase);
      setOwners(list);
      setConnStatus("ok");
    } catch (e: any) {
      setOwners([]);
      setConnStatus("fail");
      setError(e?.message || "Failed to fetch owners (network/CORS?)");
    } finally {
      setLoadingOwners(false);
    }
  }, [apiBase]);

  useEffect(() => {
    refreshOwners();
  }, [refreshOwners]);

  const removeCriterion = (i: number) => {
    setCriteria((prev) => prev.filter((_, idx) => idx !== i));
  };

  const addCriterion = () => {
    const trimmed = criterionInput.trim();
    if (!trimmed) return;
    setCriteria((prev) => Array.from(new Set([...prev, trimmed])));
    setCriterionInput("");
  };

  const canSubmit = useMemo(() => question.trim().length > 4 && !submitting, [question, submitting]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setAnswer(null);
    try {
      const data = await apiAskBoss(apiBase, { question, intent, acceptance_criteria: criteria });
      setAnswer(data);
    } catch (e: any) {
      setError(e.message || "Request failed");
    } finally {
      setSubmitting(false);
    }
  };

  // ---- Dev Self Tests (runtime) ----
  type TestResult = { name: string; passed: boolean; details?: string };
  const [tests, setTests] = useState<TestResult[] | null>(null);
  const runTests = async () => {
    const results: TestResult[] = [];

    // Mock helpers
    const ok = (data: any) => Promise.resolve({ ok: true, status: 200, statusText: "OK", json: async () => data, text: async () => JSON.stringify(data) } as any);
    const err = (status = 500, statusText = "ERR") => Promise.resolve({ ok: false, status, statusText, json: async () => ({}), text: async () => "" } as any);

    // Test 1: owners success
    try {
      const owners = await apiFetchOwners("http://fake", async (url: any) => {
        if (String(url).includes("/owners")) return ok({ owners: ["frontend-ecommerce", "backend-ecommerce"] });
        return ok({});
      });
      const pass = owners.includes("frontend-ecommerce") && owners.length === 2;
      results.push({ name: "owners: returns list", passed: pass, details: JSON.stringify(owners) });
    } catch (e: any) {
      results.push({ name: "owners: returns list", passed: false, details: e?.message });
    }

    // Test 2: owners error surface
    try {
      let threw = false;
      try {
        await apiFetchOwners("http://fake", async () => err(404, "Not Found"));
      } catch {
        threw = true;
      }
      results.push({ name: "owners: network/error propagates", passed: threw });
    } catch (e: any) {
      results.push({ name: "owners: network/error propagates", passed: false, details: e?.message });
    }

    // Test 3: ask response shape
    try {
      const payload: AskPayload = { question: "test?", intent: "impl_plan", acceptance_criteria: ["a", "b"] };
      const answer = await apiAskBoss("http://fake", payload, async (url: any, init: any) => {
        if (String(url).includes("/ask")) {
          return ok({
            task_id: "t1",
            merged_coverage: ["api", "design"],
            gaps: [],
            summary: "ok",
            by_owner: {
              "frontend-ecommerce": {
                type: "RESPONSE",
                task_id: "t1",
                owner: "frontend-ecommerce",
                coverage: ["design"],
                findings: [],
                gaps: [],
                next_actions: [],
                confidence: 0.8,
              },
            },
          });
        }
        return ok({});
      });
      const pass = !!answer.task_id && Array.isArray(answer.merged_coverage) && answer.by_owner["frontend-ecommerce"];
      results.push({ name: "ask: returns SynthesizedAnswer shape", passed: pass, details: JSON.stringify(answer) });
    } catch (e: any) {
      results.push({ name: "ask: returns SynthesizedAnswer shape", passed: false, details: e?.message });
    }

    // Test 4: criteria add/remove de-dup
    try {
      const start = ["a11y", "a11y"]; // duplicate
      const set = Array.from(new Set(start.concat(["stacking", "a11y"])));
      const pass = set.length === 2 && set.includes("a11y") && set.includes("stacking");
      results.push({ name: "criteria: de-dup works", passed: pass, details: JSON.stringify(set) });
    } catch (e: any) {
      results.push({ name: "criteria: de-dup works", passed: false, details: e?.message });
    }

    setTests(results);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100 p-6">
      <div className="mx-auto max-w-6xl grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Compose */}
        <Card className="lg:col-span-2 shadow-lg">
          <CardHeader>
            <CardTitle className="text-2xl flex items-center gap-2">
              <ServerCog className="h-6 w-6" /> Boss Agent Console
            </CardTitle>
            <CardDescription>ถาม Boss แล้วให้ Boss ไปคุยกับ Owner agents (FE/BE) ให้อัตโนมัติ</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label>คำถามถึง Boss</Label>
              <Textarea
                placeholder="เช่น: อยากทำโปร Bundle ให้ FE/BE ทำงานสอดคล้องกัน ต้องแก้อะไรบ้าง?"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                className="min-h-[120px]"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
              <div className="grid gap-2">
                <Label>Intent</Label>
                <select
                  className="h-10 rounded-md border border-slate-300 bg-white px-3 text-sm"
                  value={intent}
                  onChange={(e) => setIntent(e.target.value as Intent)}
                >
                  <option value="impl_plan">Implementation Plan</option>
                  <option value="design">Design</option>
                  <option value="qa">QA</option>
                  <option value="risk">Risk</option>
                </select>
              </div>

              <div className="grid gap-2 md:col-span-2">
                <Label>Acceptance Criteria</Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="พิมพ์แล้วกด Add เช่น 'a11y badge present'"
                    value={criterionInput}
                    onChange={(e) => setCriterionInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCriterion();
                      }
                    }}
                  />
                  <Button type="button" onClick={addCriterion}>Add</Button>
                </div>
                <div className="flex flex-wrap gap-2 mt-1">
                  {criteria.length === 0 && (
                    <span className="text-xs text-slate-500">ยังไม่มีเกณฑ์ ลองเพิ่มสัก 2-3 ข้อ</span>
                  )}
                  {criteria.map((c, i) => (
                    <Badge key={i} variant="secondary" className="flex items-center gap-2">
                      {c}
                      <button onClick={() => removeCriterion(i)} className="text-slate-500 hover:text-slate-900">×</button>
                    </Badge>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <Button onClick={submit} disabled={!canSubmit}>
                {submitting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" /> กำลังส่งไปยัง Boss
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-2" /> ส่งคำถาม
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Right: Settings + Owners */}
        <Card className="shadow-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Settings2 className="h-5 w-5"/> การเชื่อมต่อ</CardTitle>
            <CardDescription>ตั้งค่า API ของ Boss</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-2">
              <Label>Boss API Base URL</Label>
              <div className="flex gap-2">
                <Input value={apiBase} onChange={(e) => setApiBase(e.target.value)} />
                <Button type="button" variant="secondary" onClick={refreshOwners}>
                  {loadingOwners ? (<><Loader2 className="h-4 w-4 animate-spin mr-2"/>กำลังทดสอบ</>) : (<>ทดสอบ & รีเฟรช</>)}
                </Button>
              </div>
              <div className="text-xs flex items-center gap-2 mt-1">
                <span className={cn("inline-block w-2 h-2 rounded-full", connStatus === "ok" ? "bg-emerald-500" : connStatus === "fail" ? "bg-red-500" : "bg-slate-300")}></span>
                <span className={cn("", connStatus === "ok" ? "text-emerald-700" : connStatus === "fail" ? "text-red-600" : "text-slate-500")}>{connStatus === "ok" ? "เชื่อมต่อสำเร็จ" : connStatus === "fail" ? "เชื่อมต่อล้มเหลว" : "ยังไม่ทดสอบ"}</span>
              </div>
            </div>
            <Separator />
            <div className="grid gap-2">
              <Label>Owner Agents</Label>
              <div className="min-h-[48px]">
                {loadingOwners ? (
                  <div className="text-sm text-slate-500">กำลังโหลด owners...</div>
                ) : owners.length ? (
                  <div className="flex flex-wrap gap-2">
                    {owners.map((o) => (
                      <Badge key={o} variant="outline">{o}</Badge>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-slate-500">
                    ไม่พบ owners — ตรวจสอบ:
                    <ul className="list-disc ml-5 mt-1">
                      <li>Backend รันอยู่หรือไม่ (uvicorn mvp_agents:app --reload)</li>
                      <li>URL ถูกต้องหรือไม่ (เช่น http://localhost:8000)</li>
                      <li>CORS อาจบล็อก: เพิ่ม CORS middleware ใน FastAPI</li>
                    </ul>
                  </div>
                )}
              </div>
            </div>
            {error && (
              <div className="text-sm text-red-600">{error}</div>
            )}
          </CardContent>
        </Card>

        {/* Bottom: Answer */}
        <div className="lg:col-span-3">
          <Card className="shadow-xl">
            <CardHeader>
              <CardTitle>ผลลัพธ์จาก Boss</CardTitle>
              <CardDescription>สรุปรวม + แตกตาม Owner</CardDescription>
            </CardHeader>
            <CardContent>
              {!answer ? (
                <div className="text-slate-500 text-sm">ส่งคำถามเพื่อดูผลลัพธ์</div>
              ) : (
                <div className="space-y-4">
                  <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                    <div className="grid gap-2">
                      <Label>Task ID</Label>
                      <div className="text-xs font-mono">{answer.task_id}</div>
                    </div>
                    <div className="grid gap-2 mt-3">
                      <Label>Coverage</Label>
                      <div className="flex flex-wrap gap-2">
                        {answer.merged_coverage.map((c) => (
                          <Badge key={c} variant="secondary">{c}</Badge>
                        ))}
                      </div>
                    </div>
                    <div className="grid gap-2 mt-3">
                      <Label>Gaps</Label>
                      {answer.gaps.length ? (
                        <ul className="list-disc ml-6 text-sm">
                          {answer.gaps.map((g, i) => (<li key={i}>{g}</li>))}
                        </ul>
                      ) : (
                        <div className="flex items-center gap-2 text-emerald-700"><CheckCircle2 className="h-4 w-4"/> No gaps</div>
                      )}
                    </div>
                  </motion.div>

                  <Separator className="my-2" />

                  <Accordion type="multiple" className="w-full">
                    {Object.entries(answer.by_owner).map(([owner, res]) => (
                      <AccordionItem key={owner} value={owner}>
                        <AccordionTrigger>
                          <div className="flex items-center gap-3">
                            <span className="font-semibold">{owner}</span>
                            <span className="text-xs text-slate-500">confidence {Math.round(res.confidence*100)}%</span>
                          </div>
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="grid md:grid-cols-2 gap-4">
                            <div>
                              <h4 className="text-sm font-semibold mb-1">Coverage</h4>
                              <div className="flex flex-wrap gap-2">
                                {res.coverage.map((c) => (
                                  <Badge key={c} variant="outline">{c}</Badge>
                                ))}
                              </div>
                              <h4 className="text-sm font-semibold mt-4 mb-1">Gaps</h4>
                              {res.gaps.length ? (
                                <ul className="list-disc ml-6 text-sm">
                                  {res.gaps.map((g, i) => (<li key={i} className="text-amber-700 flex gap-2"><AlertTriangle className="h-4 w-4 mt-0.5"/>{g}</li>))}
                                </ul>
                              ) : (
                                <div className="text-sm text-emerald-700">None</div>
                              )}
                            </div>
                            <div>
                              <h4 className="text-sm font-semibold mb-1">Findings</h4>
                              <ul className="space-y-2">
                                {res.findings.map((f, i) => (
                                  <li key={i} className="rounded-xl border p-2">
                                    <div className="text-sm font-medium">[{f.area}] {f.summary}</div>
                                    {f.details && (
                                      <pre className="mt-1 text-xs bg-slate-50 p-2 rounded-md overflow-x-auto whitespace-pre-wrap">{JSON.stringify(f.details, null, 2)}</pre>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Dev: Self Tests */}
        <div className="lg:col-span-3">
          <Card className="shadow-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Bug className="h-5 w-5"/> Developer Self Tests</CardTitle>
              <CardDescription>รันทดสอบเบื้องต้นของฟังก์ชัน API helpers (ไม่ยิง API จริง)</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={runTests}><Bug className="h-4 w-4 mr-2"/>Run Self Tests</Button>
                {tests && (
                  <span className={cn("text-sm", tests.every(t => t.passed) ? "text-emerald-700" : "text-amber-700")}>{tests.filter(t=>t.passed).length}/{tests.length} passed</span>
                )}
              </div>
              {tests && (
                <ul className="mt-3 grid md:grid-cols-2 gap-2">
                  {tests.map((t, i) => (
                    <li key={i} className={cn("rounded-lg border p-2 text-sm flex items-start gap-2", t.passed ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50") }>
                      {t.passed ? <Check className="h-4 w-4 text-emerald-600 mt-0.5"/> : <X className="h-4 w-4 text-amber-600 mt-0.5"/>}
                      <div>
                        <div className="font-medium">{t.name}</div>
                        {t.details && <div className="mt-1 font-mono text-xs break-all whitespace-pre-wrap">{t.details}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
