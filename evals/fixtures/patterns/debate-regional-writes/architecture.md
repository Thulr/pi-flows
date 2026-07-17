# Regional write topology

Choose one indivisible topology; controls may not be borrowed across options.

- A, active-active: secondary writes give fast recovery but can duplicate external side effects during partitions.
- B, warm standby: one writer avoids multi-writer duplicates and is operationally simpler.
