#!/system/bin/sh
# post-fs-data.sh — runs before Android framework. MUST be fast and non-blocking.
# KernelSU reads sepolicy.rule automatically at this stage — no need to call ksud here.
MODDIR="${0%/*}"
