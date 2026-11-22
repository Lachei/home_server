#pragma once
#include <chrono>
#include <format>
#include <iostream>
#include <sstream>
#include <string_view>

// Minimal stream logger: LOG_WARNING << "text" << value; writes one line with timestamp on destruction
namespace logging {
class line {
public:
    explicit line(std::string_view level): _level{level} {}
    line(const line &) = delete;
    line &operator=(const line &) = delete;
    ~line() {
        // assembled first so concurrent log lines do not interleave
        std::string l = std::format("({:%F %T}) [{}] {}\n", std::chrono::floor<std::chrono::seconds>(std::chrono::system_clock::now()), _level, _stream.str());
        std::clog << l << std::flush;
    }
    template<typename T>
    line &operator<<(const T &v) { _stream << v; return *this; }

private:
    std::string_view _level;
    std::ostringstream _stream;
};
}

#define LOG_INFO logging::line{"INFO   "}
#define LOG_WARNING logging::line{"WARNING"}
#define LOG_ERROR logging::line{"ERROR  "}
