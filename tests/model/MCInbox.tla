------------------------------- MODULE MCInbox -------------------------------
(* The checked instances, with 2 agents and 2 workers. With 4 deliveries,  *)
(* agent a1 has two for task t1 and one without a task, and a2 has one.    *)
(* Progress is checked with 3: a1's two for task t1 and a2's one.          *)
EXTENDS Inbox, TLC

MCAgentOf == (1 :> "a1") @@ (2 :> "a1") @@ (3 :> "a1") @@ (4 :> "a2")
MCTaskOf == (1 :> "t1") @@ (2 :> "t1") @@ (3 :> "none") @@ (4 :> "none")
MCAgentOf3 == (1 :> "a1") @@ (2 :> "a1") @@ (3 :> "a2")
MCTaskOf3 == (1 :> "t1") @@ (2 :> "t1") @@ (3 :> "none")
\* Workers are interchangeable. Only safety checks use this: TLC may miss a
\* liveness violation under symmetry.
MCWorkerSymmetry == Permutations(Workers)
=============================================================================
