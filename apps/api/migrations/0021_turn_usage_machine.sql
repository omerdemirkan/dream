-- What each turn or task's run asked of the sandbox, from dreamd's readings while it ran (`MachineUse`): the peak
-- memory and swap in use against their totals (MB), pages swapped in and out (/proc/vmstat pswpin, pswpout), the
-- processes the kernel killed for memory, and the free disk on $HOME when it ended. Null for dreamd builds before
-- November 8, 2026, and for turns the archive interrupted.
ALTER TABLE turn_usage ADD COLUMN mem_peak_mb INTEGER;
ALTER TABLE turn_usage ADD COLUMN mem_total_mb INTEGER;
ALTER TABLE turn_usage ADD COLUMN swap_peak_mb INTEGER;
ALTER TABLE turn_usage ADD COLUMN swap_total_mb INTEGER;
ALTER TABLE turn_usage ADD COLUMN swap_in_pages INTEGER;
ALTER TABLE turn_usage ADD COLUMN swap_out_pages INTEGER;
ALTER TABLE turn_usage ADD COLUMN oom_kills INTEGER;
ALTER TABLE turn_usage ADD COLUMN disk_free_mb INTEGER;
