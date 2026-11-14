-------------------------------- MODULE Inbox --------------------------------
(***************************************************************************)
(* The Inbox's run-slot protocol: how workers claim deliveries, dispatch   *)
(* them to T3 and observe them there, when a stuck run gives way, and what *)
(* people can do about a delivery. Leases fence every write; workers can   *)
(* stall or crash; T3 may never finish a run.                              *)
(*                                                                         *)
(* A delivery is dispatched once its launch is journaled: from then on T3  *)
(* may have it, so it is observed, never dispatched afresh. Time is not    *)
(* modeled; each deadline is an action that time eventually enables:      *)
(* LeaseExpire (the lease), GiveWay (10/20/15 minutes stuck), Abandon      *)
(* (3 days after dispatch) and Expire (7 days undispatched).               *)
(*                                                                         *)
(* Bugs names known-bad variants; MCInbox.<bug>.cfg checks that each one   *)
(* breaks the property it names.                                           *)
(*                                                                         *)
(* Each worker action is one transaction in src/persistence/inbox.ts.      *)
(* "Fenced" means it matches id, generation and claim token with           *)
(* lease_until > now(), so a stale holder changes no row:                  *)
(*                                                                         *)
(*   ClaimDispatch, claim(), under pg_advisory_xact_lock: the agent's      *)
(*   ClaimObserve   oldest eligible row; generation + 1, a new claim       *)
(*                  token, lease_until = now() + 180 s; a dispatch also    *)
(*                  takes a run slot.                                      *)
(*   Journal        freeze(), fenced: the launch is written and the state  *)
(*                  becomes uncertain in the same transaction.             *)
(*   FailEarly      defer(ready), fenced, before freeze().                 *)
(*   Send           the T3 launch with the delivery's native key; no SQL.  *)
(*   Record         remember() and defer(waiting | uncertain), fenced.     *)
(*   Observe        ack(), fenced, for a finished run; else defer().       *)
(*   Block          defer(blocked), fenced, with the lost precondition.    *)
(*   Drop           a fenced write that matched no row, or releasing the   *)
(*                  worker's own claim on a final delivery.                *)
(*   Stall          the process pauses or dies; lease_until stays.         *)
(*   LeaseExpire    lease_until <= now(); claim() treats the row as free.  *)
(*   GiveWay,       claim()'s sweep: a stuck run frees its slot; 3 days    *)
(*   Abandon,       after dispatch it is abandoned; 7 days undispatched    *)
(*   Expire         it expires.                                            *)
(*   StopWaiting,   a person's action from the workspace; Resume is        *)
(*   Cancel, Resume resumeByPerson().                                      *)
(*   T3Moves        T3, not Kinmesh.                                       *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
  Deliveries,   \* a finite set of naturals; a smaller one was enqueued first
  Workers,
  AgentOf,      \* delivery -> agent
  TaskOf,       \* delivery -> task, or NoTask
  NoTask,
  Concurrency,  \* run slots per agent
  BacklogCap,   \* deliveries per agent that may have given way at once
  MaxFaults,    \* worker stalls, failures and blocks, in all
  MaxActs,      \* deliveries a person stops waiting for or cancels
  Bugs

ASSUME Deliveries \subseteq Nat /\ Concurrency \in Nat \ {0}
       /\ BacklogCap \in Nat \ {0} /\ MaxFaults \in Nat /\ MaxActs \in Nat

Agents == {AgentOf[d] : d \in Deliveries}
Final == {"acked", "expired", "abandoned"}
States == {"ready", "waiting", "uncertain", "blocked"} \cup Final
Bug(b) == b \in Bugs

VARIABLES
  st,      \* delivery state, as persisted
  disp,    \* the launch is journaled: T3 may have the run
  slot,    \* the delivery holds one of its agent's run slots
  gave,    \* it gave its slot way and is only observed now
  lease,   \* the worker whose claim is current, or 0
  key,     \* the native key a launch is sent with
  runs,    \* keys T3 has started a run for (the external effect)
  t3,      \* what T3 says about the delivery's run
  pub,     \* how many times a result was published
  phase,   \* what each worker is doing
  held,    \* the delivery each worker works on, or 0
  stalled, \* a worker that stopped running for a while, state intact
  faults,  \* stalls, failures and blocks so far
  acts     \* deliveries people stopped waiting for or cancelled so far

vars == <<st, disp, slot, gave, lease, key, runs, t3, pub, phase, held,
          stalled, faults, acts>>

Unfinished(d) == st[d] \notin Final
Queued(d) == st[d] = "ready" /\ ~disp[d]
SameAgent(d, e) == d # e /\ AgentOf[d] = AgentOf[e]
Slots(a) == {d \in Deliveries : AgentOf[d] = a /\ slot[d]}
GivenWay(a) == {d \in Deliveries : AgentOf[d] = a /\ gave[d] /\ Unfinished(d)}
Paused(a) == Cardinality(GivenWay(a)) >= BacklogCap /\ ~Bug("NoBacklogCap")
\* One run per task: no other dispatched, unfinished delivery for the same
\* agent and task, even one that gave way.
TaskFree(d) ==
  TaskOf[d] = NoTask
  \/ \A e \in Deliveries :
       (SameAgent(d, e) /\ TaskOf[e] = TaskOf[d] /\ disp[e] /\ Unfinished(e))
         => (Bug("GiveWayFreesTask") /\ gave[e])
Candidate(d) == Queued(d) /\ lease[d] = 0 /\ TaskFree(d)
\* First in, first out among the agent's deliveries that may run now.
Next1(d) == Candidate(d) /\ \A e \in Deliveries : SameAgent(d, e) /\ e < d => ~Candidate(e)
SlotFree(d) ==
  slot[d] \/ Cardinality(Slots(AgentOf[d])) < Concurrency \/ Bug("NoSlotCheck")
Dispatchable(d) == Next1(d) /\ SlotFree(d) /\ ~Paused(AgentOf[d])
Current(w) == held[w] # 0 /\ lease[held[w]] = w

Init ==
  /\ st = [d \in Deliveries |-> "ready"]
  /\ disp = [d \in Deliveries |-> FALSE]
  /\ slot = [d \in Deliveries |-> FALSE]
  /\ gave = [d \in Deliveries |-> FALSE]
  /\ lease = [d \in Deliveries |-> 0]
  /\ key = [d \in Deliveries |-> 1]
  /\ runs = [d \in Deliveries |-> {}]
  /\ t3 = [d \in Deliveries |-> "none"]
  /\ pub = [d \in Deliveries |-> 0]
  /\ phase = [w \in Workers |-> "idle"]
  /\ held = [w \in Workers |-> 0]
  /\ stalled = [w \in Workers |-> FALSE]
  /\ faults = 0
  /\ acts = 0

Release(w) == /\ phase' = [phase EXCEPT ![w] = "idle"]
              /\ held' = [held EXCEPT ![w] = 0]

(* ---------------------------- Worker actions ---------------------------- *)

\* claim(): the agent's oldest eligible dispatch takes a slot and a lease
\* (generation + 1, claim token), in one transaction.
ClaimDispatch(w, d) ==
  /\ phase[w] = "idle" /\ Dispatchable(d)
  /\ lease' = [lease EXCEPT ![d] = w]
  /\ slot' = [slot EXCEPT ![d] = TRUE]
  /\ phase' = [phase EXCEPT ![w] = "dispatch"]
  /\ held' = [held EXCEPT ![w] = d]
  /\ UNCHANGED <<st, disp, gave, key, runs, t3, pub, faults, acts, stalled>>

\* claim(): a dispatched delivery that is due is observed, in any order and
\* without a slot.
ClaimObserve(w, d) ==
  /\ phase[w] = "idle" /\ disp[d] /\ lease[d] = 0
  /\ st[d] \in {"waiting", "uncertain"}
  /\ lease' = [lease EXCEPT ![d] = w]
  /\ phase' = [phase EXCEPT ![w] = "observe"]
  /\ held' = [held EXCEPT ![w] = d]
  /\ UNCHANGED <<st, disp, slot, gave, key, runs, t3, pub, faults, acts, stalled>>

\* freeze() and the journal entry, fenced: from here T3 may have the run, so
\* the same transaction marks the delivery uncertain; a worker lost before
\* the reply leaves it to observation. A person cancelling first leaves
\* nothing to journal.
Journal(w) ==
  LET d == held[w] IN
  /\ phase[w] = "dispatch" /\ Current(w) /\ st[d] = "ready"
  /\ disp' = [disp EXCEPT ![d] = TRUE]
  /\ st' = [st EXCEPT ![d] = "uncertain"]
  /\ phase' = [phase EXCEPT ![w] = "send"]
  /\ UNCHANGED <<slot, gave, lease, key, runs, t3, pub, held, faults, acts, stalled>>

\* Failure before dispatch: the slot comes back, the delivery stays first.
FailEarly(w) ==
  LET d == held[w] IN
  /\ phase[w] = "dispatch" /\ Current(w) /\ faults < MaxFaults
  /\ slot' = [slot EXCEPT ![d] = FALSE]
  /\ lease' = [lease EXCEPT ![d] = 0]
  /\ faults' = faults + 1
  /\ Release(w)
  /\ UNCHANGED <<st, disp, gave, key, runs, t3, pub, stalled, acts>>

\* The launch, with the delivery's one native key; T3 starts one run per
\* key. It may not reach T3, or its reply may be lost. A worker sends only
\* within its lease: an attempt's deadline is shorter than the lease.
Send(w) ==
  LET d == held[w] IN
  /\ phase[w] = "send" /\ Current(w)
  /\ \/ /\ runs' = [runs EXCEPT ![d] = @ \cup {key[d]}]
        /\ t3' = [t3 EXCEPT ![d] = IF @ = "none" THEN "active" ELSE @]
        /\ phase' = [phase EXCEPT ![w] = "sentKnown"]
     \/ /\ runs' = [runs EXCEPT ![d] = @ \cup {key[d]}]
        /\ t3' = [t3 EXCEPT ![d] = IF @ = "none" THEN "active" ELSE @]
        /\ phase' = [phase EXCEPT ![w] = "sentUnknown"]
     \/ /\ phase' = [phase EXCEPT ![w] = "sentUnknown"]
        /\ UNCHANGED <<runs, t3, stalled>>
  /\ UNCHANGED <<st, disp, slot, gave, lease, key, pub, held, faults, acts, stalled>>

\* remember() / defer(), fenced: what the launch's reply said.
Record(w) ==
  LET d == held[w] IN
  /\ phase[w] \in {"sentKnown", "sentUnknown"} /\ Current(w) /\ Unfinished(d)
  /\ st' = [st EXCEPT ![d] =
              IF phase[w] = "sentKnown" THEN "waiting" ELSE "uncertain"]
  /\ lease' = [lease EXCEPT ![d] = 0]
  /\ Release(w)
  /\ UNCHANGED <<disp, slot, gave, key, runs, t3, pub, faults, acts, stalled>>

\* An observation: a finished run is published (ack(), fenced), which frees
\* its slot; an uncertain launch is sent again with the same key; anything
\* else is looked at again later.
Observe(w) ==
  LET d == held[w] IN
  /\ phase[w] = "observe"
  /\ \/ Current(w) /\ st[d] \in {"waiting", "uncertain"}
     \/ Bug("UnfencedPublish") /\ held[w] # 0
  /\ IF t3[d] = "done"
       THEN /\ pub' = [pub EXCEPT ![d] = @ + 1]
            /\ st' = [st EXCEPT ![d] = "acked"]
            /\ slot' = [slot EXCEPT ![d] = FALSE]
            /\ lease' = [lease EXCEPT ![d] = IF @ = w THEN 0 ELSE @]
            /\ Release(w)
            /\ UNCHANGED key
       ELSE IF st[d] = "uncertain"
         THEN /\ phase' = [phase EXCEPT ![w] = "send"]
              /\ key' = [key EXCEPT ![d] = IF Bug("NewKeyOnRetry") THEN @ + 1 ELSE @]
              /\ UNCHANGED <<st, slot, lease, pub, held, stalled>>
         ELSE /\ lease' = [lease EXCEPT ![d] = 0]
              /\ Release(w)
              /\ UNCHANGED <<st, slot, pub, key, stalled>>
  /\ UNCHANGED <<disp, gave, runs, t3, faults, acts, stalled>>

\* A precondition was lost (credential, channel, assignment): the delivery
\* blocks and returns its slot.
Block(w) ==
  LET d == held[w] IN
  /\ phase[w] \in {"dispatch", "observe"} /\ Current(w) /\ Unfinished(d)
  /\ faults < MaxFaults
  /\ st' = [st EXCEPT ![d] = "blocked"]
  /\ slot' = [slot EXCEPT ![d] = FALSE]
  /\ lease' = [lease EXCEPT ![d] = 0]
  /\ faults' = faults + 1
  /\ Release(w)
  /\ UNCHANGED <<disp, gave, key, runs, t3, pub, stalled, acts>>

\* A worker whose claim is gone, or whose delivery a person has ended, writes
\* nothing and moves on, letting go of a claim it still has.
Drop(w) ==
  /\ phase[w] # "idle" /\ (~Current(w) \/ ~Unfinished(held[w]))
  /\ ~(Bug("UnfencedPublish") /\ phase[w] = "observe")
  /\ lease' = IF Current(w) THEN [lease EXCEPT ![held[w]] = 0] ELSE lease
  /\ Release(w)
  /\ UNCHANGED <<st, disp, slot, gave, key, runs, t3, pub, faults, acts, stalled>>

\* A worker stalls (paused, swapped out, partitioned) between any two steps
\* and later carries on from where it was, unaware of how long it was away.
\* A crash is a stall its lease does not survive: its replacement finds the
\* claim gone and drops it, as the stalled worker does.
Stall(w) ==
  /\ phase[w] # "idle" /\ ~stalled[w] /\ faults < MaxFaults
  /\ stalled' = [stalled EXCEPT ![w] = TRUE]
  /\ faults' = faults + 1
  /\ UNCHANGED <<st, disp, slot, gave, lease, key, runs, t3, pub, phase, held, acts>>

Unstall(w) ==
  /\ stalled[w]
  /\ stalled' = [stalled EXCEPT ![w] = FALSE]
  /\ UNCHANGED <<st, disp, slot, gave, lease, key, runs, t3, pub, phase, held,
                 faults, acts>>

(* ----------------------------- Time passing ----------------------------- *)

\* A working worker finishes or aborts an attempt (90 s) well within its
\* lease (180 s), so a lease runs out only under a worker that crashed or
\* stalled.
LeaseExpire(d) ==
  /\ lease[d] # 0
  /\ held[lease[d]] # d \/ stalled[lease[d]]
  /\ lease' = [lease EXCEPT ![d] = 0]
  /\ UNCHANGED <<st, disp, slot, gave, key, runs, t3, pub, phase, held, faults, acts, stalled>>

\* 10 minutes waiting for approval, 20 without progress or 15 uncertain: the
\* run gives its slot way and is only observed from now on. At the backlog
\* cap it keeps its slot.
GiveWay(d) ==
  /\ slot[d] /\ disp[d] /\ Unfinished(d) /\ ~gave[d] /\ t3[d] # "done"
  /\ ~Paused(AgentOf[d])
  /\ gave' = [gave EXCEPT ![d] = TRUE]
  /\ slot' = [slot EXCEPT ![d] = FALSE]
  /\ UNCHANGED <<st, disp, lease, key, runs, t3, pub, phase, held, faults, acts, stalled>>

\* 3 days after dispatch, observation ends; nothing is published.
Abandon(d) ==
  /\ disp[d] /\ Unfinished(d) /\ ~Bug("NoDeadline")
  /\ st' = [st EXCEPT ![d] = "abandoned"]
  /\ slot' = [slot EXCEPT ![d] = slot[d] /\ Bug("AbandonKeepsSlot")]
  /\ UNCHANGED <<disp, gave, lease, key, runs, t3, pub, phase, held, faults, acts, stalled>>

\* 7 days undispatched.
Expire(d) ==
  /\ Queued(d) /\ lease[d] = 0
  /\ st' = [st EXCEPT ![d] = "expired"]
  /\ slot' = [slot EXCEPT ![d] = FALSE]
  /\ UNCHANGED <<disp, gave, lease, key, runs, t3, pub, phase, held, faults, acts, stalled>>

(* ------------------------------ T3 itself ------------------------------- *)

\* A run ends: it finishes, fails, or a person stops it in T3; observation
\* then publishes what it said. It need never end. Waiting for approval is
\* not modeled apart: it only decides when a run gives way.
T3Moves(d) ==
  /\ t3[d] = "active" /\ t3' = [t3 EXCEPT ![d] = "done"]
  /\ UNCHANGED <<st, disp, slot, gave, lease, key, runs, pub, phase, held, faults, acts, stalled>>

(* ---------------------- People (#78), never forced ---------------------- *)

\* Stop waiting: a dispatched delivery is abandoned and frees its slot;
\* T3 is not called.
StopWaiting(d) ==
  /\ acts < MaxActs /\ acts' = acts + 1
  /\ disp[d] /\ st[d] \in {"waiting", "uncertain", "blocked"}
  /\ st' = [st EXCEPT ![d] = "abandoned"]
  /\ slot' = [slot EXCEPT ![d] = FALSE]
  /\ UNCHANGED <<disp, gave, lease, key, runs, t3, pub, phase, held, faults, stalled>>

\* Cancel: an undispatched delivery is abandoned.
Cancel(d) ==
  /\ acts < MaxActs /\ acts' = acts + 1
  /\ ~disp[d] /\ st[d] \in {"ready", "blocked"}
  /\ st' = [st EXCEPT ![d] = "abandoned"]
  /\ slot' = [slot EXCEPT ![d] = FALSE]
  /\ UNCHANGED <<disp, gave, lease, key, runs, t3, pub, phase, held, faults, stalled>>

\* Resume a blocked delivery: back to the queue, or to observation.
Resume(d) ==
  /\ st[d] = "blocked"
  /\ st' = [st EXCEPT ![d] = IF disp[d] THEN "uncertain" ELSE "ready"]
  /\ UNCHANGED <<disp, slot, gave, lease, key, runs, t3, pub, phase, held, faults, acts, stalled>>

(* ------------------------------------------------------------------------ *)

Works(w) ==
  \/ \E d \in Deliveries : ClaimDispatch(w, d) \/ ClaimObserve(w, d)
  \/ Journal(w) \/ FailEarly(w) \/ Send(w) \/ Record(w) \/ Observe(w)
  \/ Block(w) \/ Drop(w)

WorkerStep(w) ==
  \/ ~stalled[w] /\ Works(w)
  \/ Stall(w) \/ Unstall(w)

Next ==
  \/ \E w \in Workers : WorkerStep(w)
  \/ \E d \in Deliveries :
       \/ LeaseExpire(d) \/ GiveWay(d) \/ Abandon(d) \/ Expire(d)
       \/ T3Moves(d) \/ StopWaiting(d) \/ Cancel(d) \/ Resume(d)

\* Workers keep working and deadlines arrive. A claim the scheduler keeps
\* offering is eventually taken (strong fairness): claim() alternates due
\* observations with the next dispatch. People, T3 and the 7-day expiry are
\* never forced; stalls and failures are bounded by MaxFaults, people's
\* stopping and cancelling by MaxActs.
Fairness ==
  /\ \A w \in Workers :
       /\ SF_vars(~stalled[w] /\ \E d \in Deliveries : ClaimDispatch(w, d))
       /\ SF_vars(~stalled[w] /\ \E d \in Deliveries : ClaimObserve(w, d))
       /\ WF_vars(~stalled[w] /\ Journal(w))
       /\ WF_vars(~stalled[w] /\ Send(w))
       /\ WF_vars(~stalled[w] /\ Record(w))
       /\ WF_vars(~stalled[w] /\ Observe(w))
       /\ WF_vars(~stalled[w] /\ Drop(w))
       /\ WF_vars(Unstall(w))
  /\ \A d \in Deliveries :
       WF_vars(LeaseExpire(d)) /\ WF_vars(GiveWay(d)) /\ WF_vars(Abandon(d))

Spec == Init /\ [][Next]_vars /\ Fairness

(* ------------------------------ Properties ------------------------------ *)

TypeOK ==
  /\ st \in [Deliveries -> States]
  /\ disp \in [Deliveries -> BOOLEAN]
  /\ slot \in [Deliveries -> BOOLEAN]
  /\ gave \in [Deliveries -> BOOLEAN]
  /\ lease \in [Deliveries -> Workers \cup {0}]
  /\ phase \in [Workers -> {"idle", "dispatch", "send", "sentKnown",
                            "sentUnknown", "observe"}]
  /\ held \in [Workers -> Deliveries \cup {0}]
  /\ stalled \in [Workers -> BOOLEAN]

\* Held slots per agent never exceed its concurrency.
SlotBound == \A a \in Agents : Cardinality(Slots(a)) <= Concurrency

\* At most one unfinished dispatched delivery per agent and task.
OneRunPerTask ==
  \A d, e \in Deliveries :
    (SameAgent(d, e) /\ TaskOf[d] # NoTask /\ TaskOf[d] = TaskOf[e])
      => ~(disp[d] /\ disp[e] /\ Unfinished(d) /\ Unfinished(e))

\* No delivery is dispatched twice: T3 has at most one run for it.
OneRun == \A d \in Deliveries : Cardinality(runs[d]) <= 1

\* No stale lease holder writes: a result is published at most once, and
\* only by the delivery's current claim, never after it was abandoned.
PublishedOnce ==
  \A d \in Deliveries : pub[d] <= 1 /\ (pub[d] = 1 => st[d] = "acked")

\* At most BacklogCap of an agent's deliveries have given way.
BacklogBound == \A a \in Agents : Cardinality(GivenWay(a)) <= BacklogCap

\* Nothing is left to do only when every delivery is settled: final, or
\* blocked until a person acts, with every worker idle.
Settled ==
  ~ENABLED Next =>
    /\ \A d \in Deliveries : st[d] \in Final \cup {"blocked"}
    /\ \A w \in Workers : phase[w] = "idle"

\* A final state is final.
FinalStays == [][\A d \in Deliveries : st[d] \in Final => st'[d] = st[d]]_vars

\* Every dispatched delivery is eventually published, abandoned or blocked.
DispatchedEnds ==
  \A d \in Deliveries :
    disp[d] ~> st[d] \in {"acked", "abandoned", "blocked"}

\* An agent's queued delivery is eventually dispatched, unless a person or
\* a precondition takes it out of the queue first.
QueuedDispatches ==
  \A d \in Deliveries :
    Queued(d) ~> (disp[d] \/ st[d] \in {"blocked", "expired", "abandoned"})

=============================================================================
