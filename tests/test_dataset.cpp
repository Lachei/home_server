#include "utils.hpp"
#include "../src/Database.hpp"

constexpr std::string_view test_data_folder{"data/test"};

namespace result
{
    static constexpr int storage_error = 1;
    static constexpr int bad_data_loaded = 2;
}

template <typename T>
T random_element()
{
    return T(rand());
}
template <>
Database::Date random_element<Database::Date>()
{
    return std::chrono::system_clock::now();
}
template <>
std::string random_element<std::string>()
{
    const int length = (rand() % 10) + 1;
    std::string res;
    res.resize(length);
    for (auto &c : res)
        c = 'a' + rand() % 26;
    return res;
}
template <>
std::vector<std::byte> random_element<std::vector<std::byte>>()
{
    const int length = (rand() % 10) + 1;
    std::vector<std::byte> res(length);
    for (auto &b : res)
        b = std::byte(rand() % 256);
    return res;
}
struct TestDataCentry
{
    std::string_view folder;
    TestDataCentry(std::string_view folder) : folder(folder)
    {
        if (!std::filesystem::exists(folder))
            std::filesystem::create_directories(folder);
    }
    ~TestDataCentry()
    {
        std::filesystem::remove_all(folder);
    }
};

template <typename T>
const std::string type_name = std::string(Database::column_type_name_v<T>);
int test_database_store_load(const int n = 100)
{
    TestDataCentry test_data_centry(test_data_folder);
    const std::string test_folder(test_data_folder);

    Database::Table::ColumnInfos column_infos{
        .column_names = {"id", "string", "double", "time", "byte"},
        .column_types = {type_name<uint64_t>, type_name<std::string>, type_name<double>, type_name<Database::Date>, type_name<std::vector<std::byte>>},
        .id_column = 0u};

    std::vector<Database::ColumnType> test_data{std::vector<uint64_t>(n), std::vector<std::string>(n), std::vector<double>(n), std::vector<Database::Date>(n), std::vector<std::vector<std::byte>>(n)};
    for (auto &v : test_data)
    {
        std::visit([](auto &&v)
                   {
                       for (auto &e : v)
                           e = random_element<std::decay_t<decltype(e)>>();
                   },
                   v);
    }

    try
    {
        Database test(test_folder);
        test.create_table("test_table", column_infos);
        test.insert_rows("test_table", test_data);
    }
    catch (std::runtime_error e)
    {
        std::cout << "[Error data store] " << e.what() << std::endl;
        return result::storage_error;
    }

    try
    {
        Database test(test_folder);
        const auto &loaded_data = test.get_table_data("test_table");
        if (loaded_data != test_data)
            return result::bad_data_loaded;
    }
    catch (std::runtime_error e)
    {
        std::cout << "[Error data load] " << e.what() << std::endl;
        return result::storage_error;
    }

    return result::success;
}

int main()
{
    check_res(test_database_store_load());

    return result::success;
}