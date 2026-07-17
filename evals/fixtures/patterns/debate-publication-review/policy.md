# Launch policy

All launch gates are hard and apply before publication.
Overall unsupported-publication rate must be at most 0.50%; every cohort must be at most 0.80%.
Use each raw rate's upper bound and each control's catch-rate lower bound.
Residual rate = raw upper bound * (1 - catch lower bound). Percentage-point review additions are additive.
Review hours = daily volume * review share * minutes per review / 60.
Only controls deployed before launch count. Post-publication discovery cannot cure a launch-gate violation.
If B launches, move all publication to manual hold if overall exceeds 0.50% or any cohort exceeds 0.80% in a rolling 2,000-publication audit, or if review demand exceeds 10 hours/day for 3 consecutive days.
