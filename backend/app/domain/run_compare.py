"""Compares two moments of an API's checks: what broke, what was fixed, what still fails, what slowed down.

Shared by the web app (which sends the latest result of every check at two moments of Run history)
and `api-qa run --baseline` (which compares a run with an earlier JSON report)."""

from typing import Literal

from pydantic import BaseModel, Field, computed_field

from app.domain.reports import RunReport, failure_message

# The same rule as Slowed down on Trends: at least 50% and 50 ms slower.
SLOWER_RATIO = 1.5
SLOWER_MIN_MS = 50
FAILING = {"FAIL", "ERROR"}

Outcome = Literal["PASS", "FAIL", "ERROR", "SKIPPED"]


class CheckRecord(BaseModel):
    """The result of one check at one moment, matched across moments by endpoint and title."""

    # "GET /books", or "Flow: Book lifecycle" for a flow step.
    endpoint: str = Field(max_length=2_000)
    title: str = Field(max_length=500)
    result: Outcome
    duration_ms: int | None = None
    message: str = Field(default="", max_length=4_000)
    # Where the web app found it, so a row can open that run.
    run_id: str | None = Field(default=None, max_length=100)
    at: str | None = Field(default=None, max_length=40)

    @property
    def key(self) -> tuple[str, str]:
        return (self.endpoint, self.title)


class ComparedCheck(BaseModel):
    endpoint: str
    title: str
    before: CheckRecord | None = None
    after: CheckRecord | None = None
    # Still failing, but for another reason than before.
    message_changed: bool = False


class RunComparison(BaseModel):
    newly_failing: list[ComparedCheck] = Field(default_factory=list)
    fixed: list[ComparedCheck] = Field(default_factory=list)
    still_failing: list[ComparedCheck] = Field(default_factory=list)
    slower: list[ComparedCheck] = Field(default_factory=list)
    only_before: list[ComparedCheck] = Field(default_factory=list)
    only_after: list[ComparedCheck] = Field(default_factory=list)
    unchanged_passing: int = 0

    @computed_field
    @property
    def totals(self) -> dict[str, int]:
        return {
            "newly_failing": len(self.newly_failing),
            "fixed": len(self.fixed),
            "still_failing": len(self.still_failing),
            "slower": len(self.slower),
            "only_before": len(self.only_before),
            "only_after": len(self.only_after),
            "unchanged_passing": self.unchanged_passing,
        }


class CompareRequest(BaseModel):
    before: list[CheckRecord] = Field(max_length=20_000)
    after: list[CheckRecord] = Field(max_length=20_000)


def _latest(records: list[CheckRecord]) -> dict[tuple[str, str], CheckRecord]:
    """The last record of each check; a skipped check did not run, so it does not count."""
    latest: dict[tuple[str, str], CheckRecord] = {}
    for record in records:
        if record.result != "SKIPPED":
            latest[record.key] = record
    return latest


def is_slower(before: CheckRecord, after: CheckRecord) -> bool:
    if before.duration_ms is None or after.duration_ms is None:
        return False
    return after.duration_ms >= before.duration_ms * SLOWER_RATIO and after.duration_ms - before.duration_ms >= SLOWER_MIN_MS


def compare_runs(before: list[CheckRecord], after: list[CheckRecord]) -> RunComparison:
    earlier, later = _latest(before), _latest(after)
    comparison = RunComparison()
    for key in sorted(earlier.keys() | later.keys()):
        old, new = earlier.get(key), later.get(key)
        item = ComparedCheck(endpoint=key[0], title=key[1], before=old, after=new)
        if old is None:
            comparison.only_after.append(item)
        elif new is None:
            comparison.only_before.append(item)
        elif new.result in FAILING and old.result not in FAILING:
            comparison.newly_failing.append(item)
        elif old.result in FAILING and new.result not in FAILING:
            comparison.fixed.append(item)
        elif new.result in FAILING:
            comparison.still_failing.append(item.model_copy(update={"message_changed": old.message != new.message}))
        elif is_slower(old, new):
            comparison.slower.append(item)
        else:
            comparison.unchanged_passing += 1
    return comparison


def records_from_report(report: RunReport) -> list[CheckRecord]:
    """The checks and flow steps of an `api-qa run` report, as comparable records."""
    records = [
        CheckRecord(
            endpoint=endpoint.key,
            title=check.title,
            result=check.result.result,
            duration_ms=check.result.duration_ms,
            message="" if check.result.result == "PASS" else failure_message(check.result),
            at=report.generated_at,
        )
        for endpoint in report.endpoints
        for check in endpoint.checks
    ]
    for flow in report.flows:
        for step in flow.result.steps if flow.result else []:
            records.append(CheckRecord(
                endpoint=flow.suite_name,
                title=step.title,
                result=step.status,
                duration_ms=step.check.duration_ms if step.check else None,
                message=step.reason or (failure_message(step.check) if step.check and step.status != "PASS" else ""),
                at=report.generated_at,
            ))
    return records
