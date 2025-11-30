#include "data_util.hpp"
#include "nlohmann/json.hpp"
#include "util.hpp"
#include "robin_hood/robin_hood.h"
#include "git_util.hpp"

#include <filesystem>
#include <fstream>

namespace data_util
{
    robin_hood::unordered_map<std::string, std::mutex>& get_file_locks() {
        static robin_hood::unordered_map<std::string, std::mutex> locks{};
        return locks;
    }

    void setup_data(std::string_view dir)
    {
        if (!std::filesystem::exists(dir))
            std::filesystem::create_directories(dir);
    }

    nlohmann::json get_dir_infos(std::string_view base, std::string_view dir)
    {
        const std::string directory = std::string(base) + dir.data();
        nlohmann::json ret{{"elements", nlohmann::json::array()}};
        if (!std::filesystem::exists(directory))
            return {{"error", "The directory does not exist"}};
        for (const auto &e : std::filesystem::directory_iterator(directory))
        {
            const auto p = e.path();
            ret["elements"].push_back(nlohmann::json{
                {"extension", p.extension().string().size() ? p.extension().string().substr(1): p.extension().string()},
                {"name", p.filename()},
                {"size", e.is_directory() ? 0: e.file_size()},
                {"changed_by", "Nobody"},
                {"type", e.is_directory() ? "d": "f"},
#ifdef _WIN32
                {"change_date", to_json_date_string(std::chrono::file_clock::to_utc(e.last_write_time()))},
#else
                {"change_date", to_json_date_string(std::chrono::time_point_cast<std::chrono::utc_clock::duration>(std::chrono::utc_clock::from_sys(std::chrono::file_clock::to_sys(e.last_write_time()))))},
#endif
                {"full_path", p.string().substr(base.length())}
            });
        }
        return ret;
    }

    // by default new directories are not added to the git index, thus for now user is not used
    nlohmann::json create_dir(std::string_view, std::string_view dir)
    {
        // sanitize dir
        std::string final_dir{dir};
        std::ranges::replace(final_dir, ' ', '_');
        std::filesystem::create_directories(final_dir);
        return nlohmann::json{{"success", "Directory was created successfully"}};
    }

    nlohmann::json update_file(std::string_view user, std::string_view file, std::span<const std::byte> data, std::string_view base_version)
    {
        std::string final_file{file};
        std::ranges::replace(final_file, ' ', '_');
        std::scoped_lock lock(get_file_locks()[final_file]);
        std::string hash = git_util::try_get_latest_commit_hash(final_file);
        std::string merged_content{}; // needed to store the possibly merged file content
        std::cout << "base_version " << base_version << std::endl;
        std::cout << "hash " << hash << std::endl;
        if (hash.size() && base_version.size()) { // the file is in the git index -> do merge check (in case of double edit)
            if (hash != base_version) { // merge scenario
                std::ifstream f(final_file.c_str(), std::ios_base::binary);
                std::string cur_content{std::istreambuf_iterator<char>{f}, std::istreambuf_iterator<char>{}};
                std::string base_content = git_util::get_file_at_version(final_file, base_version);
                std::string_view new_content{reinterpret_cast<const char*>(data.data()), data.size()};
                merged_content = git_util::merge_strings(base_content, cur_content, new_content);
                data = std::span<const std::byte>(reinterpret_cast<const std::byte*>(merged_content.data()), merged_content.size());
            }
        }
        std::ofstream f(final_file.c_str(), std::ios_base::binary);
        f.write(reinterpret_cast<const char*>(data.data()), data.size());
        f.flush();
        std::string new_version = git_util::try_commit_changes(user, final_file);
        return {{"success", "Updated/created the file"}, {"revision", new_version}, {"merged_content", merged_content}};
    }

    nlohmann::json delete_files(std::string_view user, std::string_view base_dir, const nlohmann::json &files)
    {
        if (!files.is_array())
            return {{"error", "Expected array for files to delete"}};
        for (const auto& f: files) {
            const auto file = base_dir.data() + f.get<std::string>();
            if (!std::filesystem::exists(file))
                continue;
            std::filesystem::remove_all(file);
        }
        git_util::try_commit_changes(user, base_dir);
        return nlohmann::json{{"success", "Removed the files/directories"}};
    }

    nlohmann::json move_files(std::string_view user, std::string_view base_dir, const nlohmann::json &move_infos)
    {
        const bool copy = move_infos["copy"].get<bool>();
        const auto file_list = move_infos["files"];
        const auto new_file_folder = base_dir.data() + move_infos["files_to"].get<std::string>(); // this is a folder
        if (!std::filesystem::exists(new_file_folder))
            std::filesystem::create_directories(new_file_folder);
        for(auto i: i_range(file_list.size()))
        {
            const std::string src = base_dir.data() + file_list[i].get<std::string>();
            if (!std::filesystem::exists(src))
                continue;
            
            if (move_infos.contains("duplicate"))
            {
                for (auto j: i_range(move_infos["duplicate"].get<int>()))
                {
                    const std::filesystem::path src_path(src);
                    const std::string new_file = new_file_folder + src_path.stem().string() + std::to_string(j) + src_path.extension().string();
                    std::filesystem::copy(src, new_file);
                }
            }
            else if (move_infos.contains("new_name"))
            {
                std::string new_name(move_infos["new_name"].get<std::string>());
                std::ranges::replace(new_name, ' ', '_');
                const std::filesystem::path new_name_p{new_name};
                const std::filesystem::path src_path(src);
                const std::string new_file = new_file_folder + new_name_p.stem().string() + (new_name_p.has_extension() ? new_name_p.extension().string(): src_path.extension().string());
                std::filesystem::rename(src, new_file);
            }
            else
            {
                const std::string new_file = new_file_folder + std::filesystem::path(src).filename().string();

                if (copy)
                    std::filesystem::copy(src, new_file);
                else
                    std::filesystem::rename(src, new_file);
            }
        }
        git_util::try_commit_changes(user, base_dir);
        return nlohmann::json{{"success", "copied/moved the files"}};
    }

    std::string read_file(std::string_view file)
    {
        std::ifstream f(file.data(), std::ios_base::binary);
        return std::string{std::istreambuf_iterator<char>{f}, std::istreambuf_iterator<char>{}};
    }


    std::string check_file_revision(std::string_view path, std::string_view client_revision) {
        crow::mustache::template_t json_template{"{\"file_revision\":\"{{&file_revision}}\",\"file_data\":\"{{&file_data}}\"}"};
        crow::mustache::context crow_context{};

        std::string server_revision = git_util::get_latest_commit_hash(path);
        if (server_revision != client_revision) {
            crow_context["file_data"] = crow::json::escape(read_file(path));
            crow_context["file_revision"] = server_revision;
        }

        return json_template.render_string(crow_context);
    }
}
