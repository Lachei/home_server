#include "data_util.hpp"
#include "nlohmann/json.hpp"
#include "util.hpp"

#include <filesystem>
#include <fstream>

namespace data_util
{
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
                {"change_date", to_json_date_string(std::chrono::time_point_cast<std::chrono::utc_clock::duration>(std::chrono::utc_clock::from_sys(std::chrono::sys_time<std::chrono::nanoseconds>(e.last_write_time().time_since_epoch()))))},
                {"full_path", p.string().substr(base.length())}
            });
        }
        return ret;
    }

    nlohmann::json create_dir(std::string_view dir)
    {
        return {};
    }

    nlohmann::json create_file(std::string_view file)
    {
        return {};
    }

    nlohmann::json delete_file(std::string_view file)
    {
        return {};
    }

    nlohmann::json write_file(std::string_view file, std::span<const std::byte> data)
    {
        std::ofstream f(file.data(), std::ios_base::binary);
        f.write(reinterpret_cast<const char*>(data.data()), data.size());
        return nlohmann::json{{"success", "The file was successfully stored"}};
    }

    std::vector<std::byte> read_file(std::string_view file)
    {
        return {};
    }
}