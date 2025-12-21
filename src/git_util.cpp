#include "git_util.hpp"
#include "diff_match_patch/diff_match_patch.h"
#include <memory>
#include <utility>
#include <filesystem>
#include <fstream>
#include "crow/crow.h"

#include <iostream>

namespace git_util {

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

void init_git(std::string_view path) {
    // install gitignore
    std::filesystem::path gitignore_path = std::filesystem::path(path) / ".gitignore";
    std::filesystem::path git_path = std::filesystem::path(path) / ".git";
    if (!std::filesystem::exists(gitignore_path)) {
        std::ofstream gitignore(gitignore_path);
        gitignore << R"(*
!*/
!*.json
!*.md
!*.rech
!*.tbl
!*.gpx)";
    }
    if (!std::filesystem::exists(git_path)) {
        auto [status, output] = run_command("cd " + std::string(path) + " && git init");
        if (status != EXIT_SUCCESS)
            throw std::runtime_error("Failed to init the git repo for the data folder with error " + output);
    }
    auto [status, output] = run_command("cd " + std::string(path) + " && git add . && git commit -m 'Server start state'");
}

std::string get_file_at_version(std::string_view path, std::string_view version) {
    std::filesystem::path p{path};
    auto [status, output] = run_command("cd " + p.parent_path().string() + " && git --no-pager show " + std::string(version) + ":./" + p.filename().string());
    if (status != EXIT_SUCCESS)
        throw std::runtime_error("Failed to get file " + std::string(path) + " with error: " + output);
    return output;
}

std::string get_latest_commit_hash(std::string_view file) {
    std::filesystem::path p{file};
    auto [status, output] = run_command("cd " + p.parent_path().string() + " && git rev-list -1 HEAD -- ./" + p.filename().string());
    if (status != EXIT_SUCCESS)
        throw std::runtime_error{"Getting latest commit failed with result string: " + output + " and exit code: " + std::to_string(status)};
    while (output.size() && output.back() == ' ' || output.back() == '\n')
        output.pop_back();
    return output;
}

std::string try_get_latest_commit_hash(std::string_view file) {
    try { return get_latest_commit_hash(file); } catch (...) {}
    return "";
}

std::string commit_changes(std::string_view user, std::string_view path) {
    std::string change_msg = "'[CHANGE_BY] " + std::string(user) + "'";
    std::filesystem::path p{path};
    auto [status, output] = run_command("cd " + p.parent_path().string() + " && git add . > /dev/null && git commit -m " + change_msg + " > /dev/null && git rev-parse --verify HEAD");
    if (status != EXIT_SUCCESS)
        throw std::runtime_error{"Commiting git changes failed with result string: " + output + " and exit code: " + std::to_string(status)};
    while (output.size() && output.back() == ' ' || output.back() == '\n')
        output.pop_back();
    return output;
}

std::string try_commit_changes(std::string_view user, std::string_view path) {
    try { return commit_changes(user, path); } catch(...) {}
    return "";
}

std::string merge_strings(std::string_view base_version, std::string_view a, std::string_view b) {
    // to create a merged version calculate the patches to get from the base_version to a and apply the
    // patches to version b for the final version
    using str = std::string;
    diff_match_patch<str> dmp{};
    auto base_to_a = dmp.patch_make(str{base_version}, str{a});
    auto [result, applied_patches] = dmp.patch_apply(base_to_a, str{b});
    return result;
}

std::string get_history_response(std::string_view path) {
    static const crow::mustache::template_t history_template{crow::mustache::load("history.html")};

    std::string history = get_history(path);

    crow::mustache::context crow_context{};
    crow_context["history"] = '"' + crow::json::escape(history) + '"';
    crow_context["file_path"] = std::string(path);
    crow_context["file_name"] = std::filesystem::path(path).stem();
    return history_template.render_string(crow_context);
}

std::string get_history(std::string_view path) {
    std::filesystem::path p{path};
    auto [status, output] = run_command("cd " + p.parent_path().string() + " && git --no-pager log --graph --abbrev-commit --decorate --format=format:'%C(bold green)(%as)%C(reset): %C(bold blue)%h%C(reset) - %C(white)%s%C(reset) %C(dim white)- %an%C(reset)%C(auto)%d%C(reset)' --all -- " + p.filename().string());
    if (status != EXIT_SUCCESS)
        throw std::runtime_error{"Getting the history failed with output: " + output + " and exit code: " + std::to_string(status)};
    return output;
}


std::string get_commit(std::string_view path, std::string_view hash) {
    std::filesystem::path p{path};
    auto [status, output] = run_command("cd " + p.parent_path().string() + " && git --no-pager show " + std::string(hash) + " -- " + p.filename().string());
    if (status != EXIT_SUCCESS)
        throw std::runtime_error{"Getting the diff failed with output: " + output + " and exit code: " + std::to_string(status)};
    return output;
}

}

