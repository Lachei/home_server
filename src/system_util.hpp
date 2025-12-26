#pragma once
#include <string_view>

inline std::pair<int, std::string> run_command(std::string_view cmd) { 
    FILE *pipe = popen(cmd.data(), "r");
    char buff[512];
    std::string ret{};
    if (!pipe)
        throw std::runtime_error{"Failed to open pipe for command " + std::string(cmd)};
    while(fgets(buff, sizeof(buff), pipe) != nullptr)
        ret.append(buff);
    return {pclose(pipe), std::move(ret)};
}
