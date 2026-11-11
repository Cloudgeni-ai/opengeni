CC ?= cc
CFLAGS ?= -O2 -g
BASH_INCLUDE ?= /usr/include/bash
BUILD ?= build
WARNINGS = -std=c11 -Wall -Wextra -Werror -Wformat=2 -Wshadow -Wconversion

.PHONY: all test
all: $(BUILD)/opengeni-terminal-ready.so

$(BUILD):
	mkdir -p $@

$(BUILD)/opengeni-terminal-ready.so: terminal-ready.c | $(BUILD)
	$(CC) $(CFLAGS) $(WARNINGS) -fPIC -shared -Wl,-z,noexecstack -I$(BASH_INCLUDE) -I$(BASH_INCLUDE)/include -I$(BASH_INCLUDE)/builtins -o $@ $<

test: all
	python3 tests/test_ready.py $(abspath $(BUILD)/opengeni-terminal-ready.so)
