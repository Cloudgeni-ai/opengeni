CC ?= cc
CFLAGS ?= -O2 -g
WARNINGS = -std=c11 -Wall -Wextra -Werror -Wformat=2 -Wshadow -Wconversion
BUILD ?= build

.PHONY: all test clean
all: $(BUILD)/opengeni-command-supervisor

$(BUILD):
	mkdir -p $@

$(BUILD)/opengeni-command-supervisor: supervisor.c | $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ $<

$(BUILD)/fixture: tests/fixture.c | $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ $<

$(BUILD)/kernel: tests/kernel.c supervisor.c | $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -o $@ $<

test: all $(BUILD)/fixture $(BUILD)/kernel
	$(BUILD)/kernel
	python3 tests/test_supervisor.py $(abspath $(BUILD))

clean:
	rm -f $(BUILD)/opengeni-command-supervisor $(BUILD)/fixture $(BUILD)/kernel