CC ?= cc
CFLAGS ?= -O2 -g
WARNINGS = -std=c11 -Wall -Wextra -Werror -Wformat=2 -Wshadow -Wconversion
BUILD ?= build

.PHONY: all static test test-static clean
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

static: | $(BUILD)
	sh build-static.sh $(abspath supervisor.c) $(abspath $(BUILD))

# The keeper owns exclusive root paths, so skipping its tests is not success.
test-static: static $(BUILD)/fixture $(BUILD)/kernel
	test "$$(id -u)" = 0
	$(BUILD)/kernel
	python3 tests/test_supervisor.py $(abspath $(BUILD))
	python3 tests/test_keeper.py $(abspath $(BUILD))

clean:
	rm -f $(BUILD)/opengeni-command-supervisor $(BUILD)/fixture $(BUILD)/kernel
