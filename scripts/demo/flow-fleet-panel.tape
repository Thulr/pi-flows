# Records the F8 fleet panel overlay (scripts/demo-ui.ts fleet) — fictional data only.
Output docs/images/flow-fleet-panel.gif
Set Shell "bash"
Set FontSize 15
Set Width 1050
Set Height 500
Set Padding 16
Set Framerate 20
Hide
Type "node --import tsx scripts/demo-ui.ts fleet"
Enter
Wait+Screen@30s /flow parallel/
Show
Sleep 12s
