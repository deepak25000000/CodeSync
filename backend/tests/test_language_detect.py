"""Unit tests: last-resort language sniffing from code (the INVALID_FILE net)."""

from __future__ import annotations

import pytest

from app.services.filegen import language_to_extension
from app.services.language_detect import sniff_language

CASES = [
    ("class Solution:\n    def twoSum(self, nums, target):\n        return []", "Python3"),
    (
        "public class Main {\n  public static void main(String[] a) {\n"
        "    System.out.println(1);\n  }\n}",
        "Java",
    ),
    ("#include <vector>\nusing namespace std;", "C++"),
    ("using System;\nclass P { static void Main() { Console.WriteLine(1); } }", "C#"),
    ('#include <stdio.h>\nint main() { printf("hi"); return 0; }', "C"),
    ('package main\nimport "fmt"\nfunc main() { fmt.Println(1) }', "Go"),
    ('fn main() { println!("hi"); }', "Rust"),
    ('fun main() { println("hi") }', "Kotlin"),
    ('func greet() { print("hi") }', "Swift"),
    ("interface Node { value: number }", "TypeScript"),
    ("const x = 1;\nconsole.log(x);", "JavaScript"),
    ('puts "hi"\n', "Ruby"),
    ("defmodule Foo do\nend", "Elixir"),
    ("-module(foo).\n-export([bar/0]).", "Erlang"),
    ("object Main extends App", "Scala"),
    ("import 'package:flutter/material.dart';", "Dart"),
    ("#!/bin/bash\necho hi", "Bash"),
    ("SELECT id FROM users WHERE active = 1;", "MySQL"),
    ("<?php echo 1;", "PHP"),
]


class TestSniffLanguage:
    @pytest.mark.parametrize("code,expected", CASES)
    def test_sniffs_supported_languages(self, code, expected):
        assert sniff_language(code) == expected

    @pytest.mark.parametrize("code,expected", CASES)
    def test_every_result_maps_to_a_backend_extension(self, code, expected):
        # A sniffed name the backend cannot map would still die on INVALID_FILE.
        assert language_to_extension(expected)

    @pytest.mark.parametrize("code", [None, "", "   \n  ", "12345 + 67890"])
    def test_no_guess_returns_none(self, code):
        assert sniff_language(code) is None
