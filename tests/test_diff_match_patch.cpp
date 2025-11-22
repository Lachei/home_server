#include "utils.hpp"
#include "../src/git_util.hpp"
#include <iostream>
#include <chrono>

namespace result
{
    constexpr int error = 1;
};

int test_json_patching()
{
    std::string_view base{R"({
    "a": 10,
    "b": 20,
})"};
    std::string_view a{R"({
    "a": 10,
    "b": 20,
    "d": 30,
    "ff": {"a": "b"}
})"};
    std::string_view b{R"({
    "a": 10,
    "b": 20,
    "c": 11,
    "e": [22, 11]
})"};
    std::string_view exp{R"({
    "a": 10,
    "b": 20,
    "c": 11,
    "d": 30,
})"};

    std::cout << exp << std::endl;

    auto start = std::chrono::system_clock::now();
    std::string res;
    for (int i = 0; i < 100000; ++i) {
         res = git_util::merge_strings(base, a, b);
    }
    std::cout << (std::chrono::system_clock::now() - start).count() * 1e-9 << std::endl;

    std::cout << res;

    return result::success;
}

int main()
{
    check_res(test_json_patching());
    return result::success;
}
