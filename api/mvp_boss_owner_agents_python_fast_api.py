# mvp_agents.py
# Minimal, runnable MVP showing a Boss agent orchestrating multiple Owner agents (FE/BE)
# - Python 3.10+
# - FastAPI + Uvicorn
# - Pydantic for schemas
# Run:  uvicorn mvp_agents:app --reload

from __future__ import annotations
from typing import List, Literal, Optional, Dict, Any
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uuid

# -----------------------------
# 1) Schemas
# -----------------------------
Intent = Literal["design","impl_plan","risk","qa"]

class AcceptanceCriteria(BaseModel):
    items: List[str] = Field(default_factory=list)

class BossToOwnerRequest(BaseModel):
    type: Literal["REQUEST"] = "REQUEST"
    task_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    intent: Intent = "impl_plan"
    question: str
    context: Dict[str, Any] = Field(default_factory=dict)
    acceptance_criteria: AcceptanceCriteria = Field(default_factory=AcceptanceCriteria)

class Finding(BaseModel):
    area: str
    summary: str
    details: Optional[Dict[str, Any]] = None

class OwnerToBossResponse(BaseModel):
    type: Literal["RESPONSE"] = "RESPONSE"
    task_id: str
    owner: str
    coverage: List[str]
    findings: List[Finding] = Field(default_factory=list)
    gaps: List[str] = Field(default_factory=list)
    next_actions: List[Dict[str, Any]] = Field(default_factory=list)
    confidence: float = 0.5

class SynthesizedAnswer(BaseModel):
    task_id: str
    merged_coverage: List[str]
    gaps: List[str]
    summary: str
    by_owner: Dict[str, OwnerToBossResponse]

# -----------------------------
# 2) Owner Agent base & registry
# -----------------------------
class OwnerAgent:
    name: str
    tags: List[str]

    def __init__(self, name: str, tags: List[str]):
        self.name = name
        self.tags = tags

    def handle(self, req: BossToOwnerRequest) -> OwnerToBossResponse:
        """Override in subclasses."""
        return OwnerToBossResponse(
            task_id=req.task_id,
            owner=self.name,
            coverage=[],
            findings=[],
            gaps=["Not implemented"],
            next_actions=[],
            confidence=0.0,
        )

REGISTRY: Dict[str, OwnerAgent] = {}

def register(agent: OwnerAgent):
    REGISTRY[agent.name] = agent

# -----------------------------
# 3) Example Owner Agents (FE/BE)
# -----------------------------
class FEOwner(OwnerAgent):
    def handle(self, req: BossToOwnerRequest) -> OwnerToBossResponse:
        findings = [
            Finding(area="ui", summary="Add admin form for bundle builder", details={
                "components": ["BundleForm", "BundleItemRow", "PromoBadge"],
                "routes": ["/admin/promotions/bundles/new"],
            }),
            Finding(area="data", summary="Client SDK method POST /promotions/bundles", details={}),
            Finding(area="tests", summary="Playwright flow: create→activate", details={}),
        ]
        gaps = []
        if not any("a11y" in c.lower() for c in req.acceptance_criteria.items):
            gaps.append("Missing a11y acceptance criteria")
        coverage = ["design","impl_plan","tests"]
        return OwnerToBossResponse(
            task_id=req.task_id,
            owner=self.name,
            coverage=coverage,
            findings=findings,
            gaps=gaps,
            next_actions=[{"owner":"FE","steps":["scaffold form","wire SDK","add tests"]}],
            confidence=0.75,
        )

class BEOwner(OwnerAgent):
    def handle(self, req: BossToOwnerRequest) -> OwnerToBossResponse:
        findings = [
            Finding(area="api", summary="New endpoints for bundles", details={
                "paths": [
                    "POST /promotions/bundles",
                    "GET /promotions/bundles/{id}",
                    "PATCH /promotions/bundles/{id}",
                    "POST /promotions/bundles/{id}/activate",
                ]
            }),
            Finding(area="data_model", summary="Tables: promo_bundle, promo_bundle_item"),
            Finding(area="events", summary="Emit promo.bundle.created via Kafka"),
            Finding(area="cache", summary="Redis keyspace promo:bundle:* invalidate on write"),
        ]
        gaps = []
        if not any("stack" in c.lower() for c in req.acceptance_criteria.items):
            gaps.append("Discount stacking rules unspecified")
        coverage = ["api","data_model","events","cache"]
        return OwnerToBossResponse(
            task_id=req.task_id,
            owner=self.name,
            coverage=coverage,
            findings=findings,
            gaps=gaps,
            next_actions=[{"owner":"BE","steps":["write migrations","implement service","publish events"]}],
            confidence=0.8,
        )

# Register default owners
register(FEOwner(name="frontend-ecommerce", tags=["fe","ui","react"]))
register(BEOwner(name="backend-ecommerce", tags=["be","api","db"]))

# -----------------------------
# 4) Boss Orchestrator (with simple auto-refine loop)
# -----------------------------
class Boss:
    MAX_LOOPS = 3
    coverage_targets = {"design","api","data_model","tests","risk","events","cache"}

    def route(self, req: BossToOwnerRequest) -> List[OwnerToBossResponse]:
        # naive routing: ask everyone registered. Replace with tag/intent routing later
        responses = []
        for agent in REGISTRY.values():
            responses.append(agent.handle(req))
        return responses

    def validate(self, responses: List[OwnerToBossResponse], acceptance: AcceptanceCriteria) -> List[str]:
        have = set()
        gaps: List[str] = []
        for r in responses:
            have.update(r.coverage)
            gaps.extend(r.gaps)
        missing_coverage = list(self.coverage_targets - have)
        return missing_coverage + gaps

    def synthesize(self, req: BossToOwnerRequest, responses: List[OwnerToBossResponse]) -> SynthesizedAnswer:
        merged_coverage = sorted({c for r in responses for c in r.coverage})
        all_gaps = [g for r in responses for g in r.gaps]
        summary = (
            f"Question: {req.question}\n" \
            f"Coverage: {', '.join(merged_coverage)}\n" \
            f"Gaps: {', '.join(all_gaps) if all_gaps else 'None'}"
        )
        return SynthesizedAnswer(
            task_id=req.task_id,
            merged_coverage=merged_coverage,
            gaps=all_gaps,
            summary=summary,
            by_owner={r.owner: r for r in responses}
        )

    def ask(self, req: BossToOwnerRequest) -> SynthesizedAnswer:
        loop = 0
        current_req = req
        last_syn: Optional[SynthesizedAnswer] = None
        while loop < self.MAX_LOOPS:
            responses = self.route(current_req)
            syn = self.synthesize(current_req, responses)
            gaps = self.validate(responses, current_req.acceptance_criteria)
            if not gaps:
                return syn
            # simple refine: append gaps to question and loop
            loop += 1
            current_req = BossToOwnerRequest(
                intent=current_req.intent,
                question=current_req.question + "\nPlease also resolve gaps: " + ", ".join(gaps),
                context=current_req.context,
                acceptance_criteria=current_req.acceptance_criteria,
                task_id=current_req.task_id,
            )
            last_syn = syn
        # return best-effort synthesis if still gaps remain
        return last_syn or self.synthesize(req, self.route(req))

boss = Boss()

# -----------------------------
# 5) FastAPI endpoints
# -----------------------------
app = FastAPI(title="MVP Boss/Owner Agents")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000", "http://localhost:3001", "http://127.0.0.1:3001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class AskPayload(BaseModel):
    question: str
    intent: Intent = "impl_plan"
    acceptance_criteria: Optional[List[str]] = None

@app.post("/ask", response_model=SynthesizedAnswer)
async def ask(payload: AskPayload):
    req = BossToOwnerRequest(
        intent=payload.intent,
        question=payload.question,
        acceptance_criteria=AcceptanceCriteria(items=payload.acceptance_criteria or []),
        context={}
    )
    return boss.ask(req)

@app.get("/owners")
async def owners():
    return {"owners": list(REGISTRY.keys())}

# -----------------------------
# 6) Example curl
# -----------------------------
# curl -s -X POST http://localhost:8000/ask \
#   -H 'content-type: application/json' \
#   -d '{
#     "question": "How to implement bundle promotion with FE/BE consistency?",
#     "acceptance_criteria": [
#       "User can create bundle deal",
#       "Price calc consistent FE/BE",
#       "Event emitted to kafka: promo.bundle.created",
#       "Cache invalidation in Redis",
#       "a11y badge present",
#       "stacking rules defined"
#     ]
# }' | jq .

# -----------------------------
# Notes to extend later:
# - Replace naive routing with tag-based (e.g., route BE-only questions to backend-ecommerce).
# - Wrap Owner agents as separate processes/services and call via HTTP/gRPC for real isolation.
# - Add Tool layer (e.g., Git repo introspection, Kafka/Redis validators) and pass results in `context`.
# - Add auth/guardrails before enabling code-write abilities.
