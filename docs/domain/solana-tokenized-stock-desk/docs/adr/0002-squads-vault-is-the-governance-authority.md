# Squads vault is the governance authority

The RFQ program recognizes a Squads vault PDA as its sole governance authority and does not copy individual member keys or quorum rules into program state. Squads supplies the 2-of-3 approval and proposal audit trail, while the RFQ program retains a 24-hour delayed-change queue and a separate pause-only guardian as defense in depth.
