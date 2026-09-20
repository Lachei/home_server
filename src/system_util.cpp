#include "system_util.hpp"

std::pair<int, std::string> run_command(std::string_view cmd) { 
    FILE *pipe = popen(cmd.data(), "r");
    char buff[512];
    std::string ret{};
    if (!pipe)
        throw std::runtime_error{"Failed to open pipe for command " + std::string(cmd)};
    while(fgets(buff, sizeof(buff), pipe) != nullptr)
        ret.append(buff);
    return {pclose(pipe), std::move(ret)};
}

nlohmann::json get_groups() {
    auto [success, groups] = run_command("getent group");
    if (success != 0)
        throw std::runtime_error{"Command failed: " + groups};
     nlohmann::json result{};
     std::string_view rest{groups};
     while(rest.size()) {
          std::string_view cur = rest.substr(0, rest.find('\n'));
          rest = rest.substr(cur.size() + 1);
          result.push_back(std::string(cur));
     }
     return result;
}

void add_group(std::string_view group) {
    if (group.empty())
        throw std::runtime_error{"empty group is not allowed"};
    auto [success, ret] = run_command("groupadd " + std::string(group));
    if (success != 0)
        throw std::runtime_error{"Add group failed: " + std::string(group)};
}

void delete_group(std::string_view group) {
    if (group.empty())
        throw std::runtime_error{"empty group is not allowed"};
    auto [success, ret] = run_command("groupdel " + std::string(group));
    if (success != 0)
        throw std::runtime_error{"Delete group failed: " + std::string(group)};
}
