"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Bot, CheckCircle2, CircleAlert, KeyRound, Play, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { JobView } from "@/src/types";

const SAMPLE = {
  portal: { url: "https://test-tangerine.hipeely.com/nbn/nbn-broadband#speeds" },
  customer: { title: "Mr", firstName: "Sam", lastName: "Test", email: "prime150@yopmail.com", phone: "0412345678", dateOfBirth: "01/02/1988" },
  connectionAddress: { mainAddress: { fullAddress: "17 Rochester Way, MEADOW SPRINGS WA 6210", streetNumber: "17", streetName: "Rochester", streetType: "Way", suburb: "MEADOW SPRINGS", state: "WA", postcode: "6210", unitNumber: "", country: "Australia" } },
  plan: { name: "VALUE PLUS", speed: "25 Mbps" },
  addOns: { router: { enabled: true, model: "BYO Modem" } },
  connectionDetails: { currentProvider: "Exetel", avcId: "", moveInDate: "", movingProperty: false },
  connectionDeliveryDate: "ASAP",
  payment: { method: "Credit Card", cardRef: "vault://test-cards/visa-success", nameOnCard: "Sam Test" },
};

type FormState = typeof SAMPLE;
const inputClass = "w-full rounded-md border bg-white px-3 py-2 text-sm outline-none ring-offset-2 focus:ring-2 focus:ring-blue-500";
const labelClass = "space-y-1 text-sm font-medium";

export default function Home() {
  const [form, setForm] = useState<FormState>(SAMPLE);
  const [raw, setRaw] = useState(JSON.stringify(SAMPLE, null, 2));
  const [advanced, setAdvanced] = useState(false);
  const [mutate, setMutate] = useState(false);
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [humanValue, setHumanValue] = useState("");
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    if (!advanced) setRaw(JSON.stringify(form, null, 2));
  }, [form, advanced]);

  useEffect(() => {
    if (!job || !["queued", "running", "waiting_for_human"].includes(job.status)) return;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/jobs/${job.id}`, { cache: "no-store" });
      if (response.ok) setJob(await response.json());
    }, 1200);
    return () => clearInterval(timer);
  }, [job]);

  const status = job?.status ?? "idle";
  const previewUrl = job ? `/api/jobs/${job.id}/preview?ts=${Date.now()}` : "";
  const progress = useMemo(() => !job ? 0 : (job.report?.completedSteps.length ?? Math.min(19, new Set(job.trace.map((e) => e.step).filter(Boolean)).size)), [job]);

  const setCustomer = (key: keyof FormState["customer"], value: string) => setForm((p) => ({ ...p, customer: { ...p.customer, [key]: value } }));
  const setAddress = (key: keyof FormState["connectionAddress"]["mainAddress"], value: string) => setForm((p) => ({ ...p, connectionAddress: { mainAddress: { ...p.connectionAddress.mainAddress, [key]: value } } }));
  const setConnection = (key: keyof FormState["connectionDetails"], value: string | boolean) => setForm((p) => ({ ...p, connectionDetails: { ...p.connectionDetails, [key]: value } }));

  async function run() {
    setBusy(true); setError(""); setHumanValue("");
    try {
      const payload = advanced ? JSON.parse(raw) : form;
      const response = await fetch("/api/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload, mutate }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Run failed");
      setJob(data);
    } catch (event) { setError(event instanceof Error ? event.message : String(event)); }
    finally { setBusy(false); }
  }

  async function resume(valueOverride?: string) {
    if (!job) return;
    const value = (valueOverride ?? humanValue).trim();
    if (!value) return;
    setResuming(true); setError("");
    try {
      const response = await fetch(`/api/jobs/${job.id}/human`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not resume run");
      setHumanValue(""); setJob(data);
    } catch (event) { setError(event instanceof Error ? event.message : String(event)); }
    finally { setResuming(false); }
  }

  return <main className="min-h-screen bg-slate-50"><div className="mx-auto max-w-7xl p-6 lg:p-10">
    <div className="mb-6"><div className="flex items-center gap-2 text-sm font-medium text-blue-600"><Bot className="h-4 w-4"/> CIMET NBN signup agent</div><h1 className="mt-2 text-2xl font-semibold">Create an NBN order</h1><p className="mt-1 text-sm text-slate-600">Enter the customer details once. The agent will use these values throughout Tangerine and only stop when human action is genuinely required.</p></div>
    <div className="grid gap-6 lg:grid-cols-[1.08fr_.92fr]">
      <div className="space-y-6">
        <Card><CardHeader><CardTitle>1. Customer</CardTitle><CardDescription>Details the agent is allowed to enter on the customer's behalf.</CardDescription></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2">
          <label className={labelClass}>Title<select className={inputClass} value={form.customer.title} onChange={(e)=>setCustomer("title",e.target.value)}>{["Mr","Mrs","Ms","Miss","Dr"].map(x=><option key={x}>{x}</option>)}</select></label>
          <label className={labelClass}>Date of birth<input className={inputClass} value={form.customer.dateOfBirth} onChange={(e)=>setCustomer("dateOfBirth",e.target.value)} placeholder="DD/MM/YYYY"/></label>
          <label className={labelClass}>First name<input className={inputClass} value={form.customer.firstName} onChange={(e)=>setCustomer("firstName",e.target.value)}/></label>
          <label className={labelClass}>Last name<input className={inputClass} value={form.customer.lastName} onChange={(e)=>setCustomer("lastName",e.target.value)}/></label>
          <label className={labelClass}>Email<input className={inputClass} type="email" value={form.customer.email} onChange={(e)=>setCustomer("email",e.target.value)}/></label>
          <label className={labelClass}>Australian mobile<input className={inputClass} value={form.customer.phone} onChange={(e)=>setCustomer("phone",e.target.value)} placeholder="04xxxxxxxx"/></label>
        </CardContent></Card>

        <Card><CardHeader><CardTitle>2. Service address</CardTitle><CardDescription>Full address is used for search; structured fields provide the manual-address fallback.</CardDescription></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2">
          <label className={`${labelClass} sm:col-span-2`}>Full address<input className={inputClass} value={form.connectionAddress.mainAddress.fullAddress} onChange={(e)=>setAddress("fullAddress",e.target.value)}/></label>
          <label className={labelClass}>Street number<input className={inputClass} value={form.connectionAddress.mainAddress.streetNumber} onChange={(e)=>setAddress("streetNumber",e.target.value)}/></label>
          <label className={labelClass}>Street name<input className={inputClass} value={form.connectionAddress.mainAddress.streetName} onChange={(e)=>setAddress("streetName",e.target.value)}/></label>
          <label className={labelClass}>Street type<input className={inputClass} value={form.connectionAddress.mainAddress.streetType} onChange={(e)=>setAddress("streetType",e.target.value)}/></label>
          <label className={labelClass}>Unit number<input className={inputClass} value={form.connectionAddress.mainAddress.unitNumber} onChange={(e)=>setAddress("unitNumber",e.target.value)}/></label>
          <label className={labelClass}>Suburb<input className={inputClass} value={form.connectionAddress.mainAddress.suburb} onChange={(e)=>setAddress("suburb",e.target.value)}/></label>
          <label className={labelClass}>State<input className={inputClass} value={form.connectionAddress.mainAddress.state} onChange={(e)=>setAddress("state",e.target.value)}/></label>
          <label className={labelClass}>Postcode<input className={inputClass} value={form.connectionAddress.mainAddress.postcode} onChange={(e)=>setAddress("postcode",e.target.value)}/></label>
        </CardContent></Card>

        <Card><CardHeader><CardTitle>3. Order preferences</CardTitle><CardDescription>These become the source of truth. The AI may choose where to enter them, but may not invent replacements.</CardDescription></CardHeader><CardContent className="grid gap-4 sm:grid-cols-2">
          <label className={labelClass}>Plan name<input className={inputClass} value={form.plan.name} onChange={(e)=>setForm(p=>({...p,plan:{...p.plan,name:e.target.value}}))}/></label>
          <label className={labelClass}>Router model<input className={inputClass} value={form.addOns.router.model} onChange={(e)=>setForm(p=>({...p,addOns:{router:{...p.addOns.router,model:e.target.value}}}))}/></label>
          <label className={labelClass}>Current provider<input className={inputClass} value={form.connectionDetails.currentProvider} onChange={(e)=>setConnection("currentProvider",e.target.value)}/></label>
          <label className={labelClass}>AVC ID (optional)<input className={inputClass} value={form.connectionDetails.avcId} onChange={(e)=>setConnection("avcId",e.target.value)}/></label>
          <label className={labelClass}>Move-in date (optional)<input className={inputClass} value={form.connectionDetails.moveInDate} onChange={(e)=>setConnection("moveInDate",e.target.value)}/></label>
          <label className={labelClass}>Connection date<input className={inputClass} value={form.connectionDeliveryDate} onChange={(e)=>setForm(p=>({...p,connectionDeliveryDate:e.target.value}))} placeholder="ASAP"/></label>
          <label className={labelClass}>Name on card<input className={inputClass} value={form.payment.nameOnCard} onChange={(e)=>setForm(p=>({...p,payment:{...p.payment,nameOnCard:e.target.value}}))}/></label>
          <label className={labelClass}>Test card reference<input className={inputClass} value={form.payment.cardRef} onChange={(e)=>setForm(p=>({...p,payment:{...p.payment,cardRef:e.target.value}}))}/><span className="block text-xs font-normal text-slate-500">Opaque vault reference only. PAN/CVV are never entered here or sent to AI.</span></label>
        </CardContent></Card>

        <Card><CardContent className="space-y-4 pt-6"><label className="flex items-start gap-3"><input type="checkbox" className="mt-1" checked={mutate} onChange={(e)=>setMutate(e.target.checked)}/><span><span className="block text-sm font-medium">Mutation demonstration</span><span className="text-xs text-slate-500">Changes safe controls only inside Playwright to demonstrate self-healing.</span></span></label>
          <button className="text-xs font-medium text-blue-600" onClick={()=>setAdvanced(!advanced)}>{advanced ? "Hide advanced JSON" : "Advanced: edit raw JSON"}</button>
          {advanced && <Textarea value={raw} onChange={(e)=>setRaw(e.target.value)} className="min-h-[360px] text-xs"/>}
          {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
          <Button onClick={run} disabled={busy || ["running","queued","waiting_for_human"].includes(status)} className="w-full"><Play className="h-4 w-4"/>{busy ? "Starting agent…" : mutate ? "Start mutated signup" : "Start signup"}</Button>
        </CardContent></Card>
      </div>

      <div className="space-y-6 lg:sticky lg:top-6 lg:self-start">
        <Card><CardHeader><div className="flex items-center justify-between"><div><CardTitle>Live run</CardTitle><CardDescription>{job ? job.id : "Ready to start"}</CardDescription></div><StatusBadge status={status}/></div></CardHeader><CardContent><div className="mb-2 flex justify-between text-sm"><span>Journey progress</span><span className="font-medium">{progress}/19</span></div><div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-blue-600 transition-all" style={{width:`${Math.round(progress/19*100)}%`}}/></div>{job?.report && <div className="mt-5 grid grid-cols-3 gap-3"><Metric label="Heals" value={String(job.report.heals.length)}/><Metric label="AI calls" value={String(job.report.modelCalls)}/><Metric label="Duration" value={`${Math.round(job.report.durationMs/1000)}s`}/></div>}</CardContent></Card>

        {job?.status === "waiting_for_human" && job.humanRequest && <Card className="border-amber-300 bg-amber-50 shadow-md"><CardHeader><CardTitle className="flex items-center gap-2 text-amber-900"><KeyRound className="h-5 w-5"/> Your action is needed</CardTitle><CardDescription className="text-amber-800">{job.humanRequest.message}<br/>The Tangerine browser remains open and the same session will continue.</CardDescription></CardHeader><CardContent className="space-y-3"><div className="rounded-md bg-white/70 p-3 text-xs text-amber-900"><b>{job.humanRequest.type}</b> · Step {job.humanRequest.step}</div>{job.humanRequest.type === "MANUAL_ESCALATION" ? <><Button onClick={()=>void resume("resolved")} disabled={resuming} className="w-full">{resuming ? "Re-observing and resuming…" : "I resolved it — continue"}</Button><p className="text-xs text-amber-800">Fix the issue directly in the open Tangerine browser first. The agent will then re-observe the current page instead of restarting the signup.</p></> : <><input type="text" inputMode="numeric" autoComplete="one-time-code" autoFocus value={humanValue} onChange={(e)=>setHumanValue(e.target.value)} onKeyDown={(e)=>{if(e.key==="Enter") void resume();}} placeholder="Enter the code shown/sent to you" className={inputClass}/><Button onClick={()=>void resume()} disabled={resuming || !humanValue.trim()} className="w-full">{resuming ? "Submitting and resuming…" : "Submit and continue signup"}</Button><p className="text-xs text-amber-800">This value goes directly to Playwright. It is not sent to Sarvam or written to the agent trace.</p></>}</CardContent></Card>}

        <Card><CardHeader><CardTitle>Live portal preview</CardTitle><CardDescription>{job?.status === "waiting_for_human" ? "Use the action card above, then the agent continues automatically." : "Watch the agent progress through Tangerine."}</CardDescription></CardHeader><CardContent><div className="overflow-hidden rounded-lg border bg-slate-100">{job ? <img key={job.id+status+String(progress)} src={previewUrl} alt="Live portal preview" className="aspect-[4/3] w-full bg-white object-contain"/> : <div className="flex aspect-[4/3] items-center justify-center text-sm text-slate-500">The portal preview will appear here after you start.</div>}</div></CardContent></Card>
        <Card><CardHeader><CardTitle className="flex items-center gap-2"><Activity className="h-5 w-5"/> Agent activity</CardTitle><CardDescription>Operational events only. Sensitive values are excluded.</CardDescription></CardHeader><CardContent><div className="max-h-[360px] space-y-2 overflow-auto rounded-lg bg-slate-950 p-4 font-mono text-xs text-slate-200">{!job?.trace.length ? <div className="text-slate-500">Waiting for a run…</div> : job.trace.map((entry,index)=><div key={`${entry.at}-${index}`}><span className="text-slate-500">{entry.at.slice(11,19)}</span>{" "}<span className="text-blue-300">{entry.step ? `step:${entry.step}` : "system"}</span>{" "}{entry.message}</div>)}</div></CardContent></Card>
        {job?.report && <Card><CardHeader><CardTitle>Run report</CardTitle><CardDescription>Final evidence-backed outcome.</CardDescription></CardHeader><CardContent><pre className="max-h-72 overflow-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-200">{JSON.stringify(job.report,null,2)}</pre></CardContent></Card>}
      </div>
    </div>
  </div></main>;
}

function Metric({label,value}:{label:string;value:string}) { return <div className="rounded-lg border p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-lg font-semibold">{value}</div></div>; }
function StatusBadge({status}:{status:string}) { const good=status==="success", waiting=status==="waiting_for_human", bad=status==="failed"||status==="escalated"; return <Badge className={good?"border-emerald-200 bg-emerald-50 text-emerald-700":waiting?"border-amber-300 bg-amber-100 text-amber-800":bad?"border-red-200 bg-red-50 text-red-700":"bg-white"}>{good?<CheckCircle2 className="mr-1 h-3 w-3"/>:waiting||bad?<CircleAlert className="mr-1 h-3 w-3"/>:<RefreshCw className="mr-1 h-3 w-3"/>}{status}</Badge>; }
