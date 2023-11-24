#include "Database.hpp"
#include <filesystem>
#include <fstream>
#include <sstream>
#include <numeric>

#include "util.hpp"
#include "type_serialization.hpp"

using src_loc = std::source_location;
using Types =  std::vector<uint32_t>;
using OffsetSizes = std::vector<std::pair<uint64_t, uint64_t>>;

// Database utility functions -------------------------------------------------------------

bool same_data_layout(const std::vector<Database::ColumnType>& a, const std::vector<Database::ColumnType>& b) {
    if (a.size() != b.size())
        return false;
        
    for (auto i: i_range(a.size()))
        if (a[i].index() != b[i].index())
            return false;
        
    return true;
}
// ----------------------------------------------------------------------------------------

Database::Table::Table(std::string_view storage_location, const std::optional<ColumnInfos>& column_infos):
    storage_location(std::string(storage_location))
{
    auto file_parent_path = std::filesystem::path(storage_location).parent_path();
    if(!std::filesystem::exists(file_parent_path))
        std::filesystem::create_directory(file_parent_path);

    // loading from file --------------------------------------------------------
    std::ifstream data_file(this->storage_location, std::ios_base::binary);
    if (data_file) {
        GeneralHeader general_header{};
        data_file.read(reinterpret_cast<char*>(&general_header), sizeof(general_header));
        if (general_header.magic_num != DBTABLEMAGICNUM)
            throw std::runtime_error{log_msg("Magic number for header mismatch")};
        
        // parse into the correct special header
        if (general_header.type == columnar_header_id) {
            HeaderDataColumnar header{};
            data_file.read(reinterpret_cast<char*>(&header), sizeof(header));

            // getting the column infos
            this->column_infos.id_column = header.id_column;
            std::string column_names; column_names.resize(header.column_names_len);
            data_file.seekg(header.column_names_offset, data_file.beg).read(column_names.data(), header.column_names_len);
            std::stringstream column_names_stream(column_names);
            this->column_infos.column_names.resize(header.num_columns);
            for(uint32_t i: i_range(header.num_columns))
                column_names_stream >> this->column_infos.column_names[i];
            
            Types types(header.num_columns);
            data_file.seekg(header.column_types_offset, data_file.beg).read(reinterpret_cast<char*>(types.data()), header.num_columns * sizeof(types[0]));
            
            OffsetSizes offset_sizes(header.num_columns);
            data_file.seekg(header.columns_offsets_lengths, data_file.beg).read(reinterpret_cast<char*>(offset_sizes.data()), header.num_columns * sizeof(offset_sizes[0]));
            
            if (column_infos && *column_infos != this->column_infos)
                throw std::runtime_error{log_msg("Column mismatch for stored table and requested table format")};
            

            // load data (can be loaded without seeking, as they are in the storage sequentially)
            loaded_data.resize(header.num_columns);
            for(auto i: i_range(header.num_columns)) {
                switch(types[i]){
                case type_id<float>:
                    loaded_data[i] = deserialize_type<float>(data_file, offset_sizes[i]);   break;
                case type_id<double>:
                    loaded_data[i] = deserialize_type<double>(data_file, offset_sizes[i]);  break;
                case type_id<int32_t>:
                    loaded_data[i] = deserialize_type<int32_t>(data_file, offset_sizes[i]); break;
                case type_id<int64_t>:
                    loaded_data[i] = deserialize_type<int64_t>(data_file, offset_sizes[i]); break;
                case type_id<uint32_t>:
                    loaded_data[i] = deserialize_type<uint32_t>(data_file, offset_sizes[i]);break;
                case type_id<uint64_t>:
                    loaded_data[i] = deserialize_type<uint64_t>(data_file, offset_sizes[i]);break;
                case type_id<std::string>:
                    loaded_data[i] = deserialize_type<std::string>(data_file, offset_sizes[i], header.num_rows);break;
                case type_id<Date>:
                    loaded_data[i] = deserialize_type<Date>(data_file, offset_sizes[i]);    break;
                case type_id<std::vector<std::byte>>:
                    loaded_data[i] = deserialize_type<std::vector<std::byte>>(data_file, offset_sizes[i], header.num_rows);break;
                }
            }
        }
        else
            throw std::runtime_error{log_msg("Unknown header type")};
    }
    
    // validating the column name strings (no spaces allowed)
    for (const auto& n: column_infos->column_names)
        if (n.find(' ') != std::string::npos)
            throw std::runtime_error{log_msg("The column names for a new table are not allowed to contain spaces.")};
    this->column_infos = *column_infos;
    this->loaded_data.resize(this->column_infos.column_names.size());
    for (auto i: i_range(column_infos->num_columns())){
        const size_t v_idx = std::find(column_type_names.begin(), column_type_names.end(), column_infos->column_names[i].data()) - column_type_names.begin();
        switch (v_idx) {
        case type_id<float>:
        case type_id<double>:
        case type_id<int32_t>:
        case type_id<int64_t>:
        case type_id<uint32_t>:
        case type_id<uint64_t>:
        case type_id<std::string>:
        case type_id<Date>:
        case type_id<std::vector<std::byte>>: break;
        }
    }
    
    store_cache();
}

void Database::Table::store_cache() const {
    // TODO put into an extra worker thread which does the export in the background

    std::ofstream file(storage_location, std::ios_base::binary);
    
    // gathering header additional infos
    std::stringstream names_stream;
    for(const auto& name: column_infos.column_names)
        names_stream << name << ' ';
    std::string names_string = names_stream.str();
    Types types(column_infos.num_columns());
    for(auto i: i_range(column_infos.num_columns()))
        types[i] = loaded_data[i].index();
    std::vector<uint64_t> column_sizes(column_infos.num_columns());
    for(auto i: i_range(column_infos.num_columns()))
        column_sizes[i] = std::visit([](auto&& v){ return serialized_size(v);}, loaded_data[i]);
    
    // filling header infos
    GeneralHeader general_header{
        .magic_num = DBTABLEMAGICNUM, 
        .type = columnar_header_id
    };
    HeaderDataColumnar header{
        .num_columns = column_infos.num_columns(),
        .num_rows = num_rows(),
        .id_column = column_infos.id_column,
        .column_names_offset = static_cast<uint32_t>(sizeof(GeneralHeader) + sizeof(HeaderDataColumnar)),
        .column_names_len = static_cast<uint32_t>(names_string.length()),
        .column_types_offset = header.column_names_offset + header.column_names_len,
        .columns_offsets_lengths = header.column_types_offset + static_cast<uint32_t>(column_infos.num_columns() * sizeof(uint32_t))
    };
    size_t data_start = header.columns_offsets_lengths * 2 * column_infos.num_columns() * sizeof(uint64_t);
    
    OffsetSizes offset_lengths(column_infos.num_columns());
    for(auto i: i_range(column_infos.num_columns())){
        if (i)
            offset_lengths[i].first = offset_lengths[i - 1].first + offset_lengths[i - 1].second;
        offset_lengths[i].second = column_sizes[i];
    }

    // writing to file
    file.write(reinterpret_cast<char*>(&general_header), sizeof(general_header));
    file.write(reinterpret_cast<char*>(&header), sizeof(header));
    file.write(names_string.data(), names_string.length() * sizeof(names_string[0]));
    serialize_type(file, types);
    serialize_type(file, offset_lengths);
    for (const auto& data: loaded_data)
        std::visit([&file](auto&& data){serialize_type(file, data);}, data);
}

void Database::Table::insert_rows(const std::vector<ColumnType>& data) {
    if (!same_data_layout(data, loaded_data))
        throw std::runtime_error(log_msg("The data layout for inserting data into the table is different"));
        
    for (auto i: i_range(data.size())) {
        std::visit([&data, &i](auto&& d) {
            using T = std::decay_t<decltype(d)>;
            const auto& data_v = std::get<T>(data[i]);
            d.insert(d.end(), data_v.begin(), data_v.end());
        }, loaded_data[i]);
    }
}

Database::Database(std::string_view storage_location):
    _storage_location(storage_location)
{
    // checking for the config json in the storage location, if not available create
    // the config json contains infos about the already created tables and maybe additional future information
    
    if (!std::filesystem::exists(_storage_location))
        std::filesystem::create_directory(_storage_location);
    
    std::string config_file = _storage_location + "/config.json";
    if (std::filesystem::exists(config_file)) {
        // loading the json
        std::ifstream json_file(config_file);
        auto config_json = nlohmann::json::parse(json_file);
        if (config_json.contains("tables") && config_json["tables"].is_array()) {
            for(const auto& table: config_json["tables"].get<std::vector<std::string>>())
                _tables[table] = std::make_unique<Table>(_storage_location + "/" + table);
        }
    }
}

void Database::store_table_caches() const {
    for(const auto& [n, t]: _tables)
        t->store_cache();
    std::vector<std::string> tables(_tables.size());
    size_t i{};
    for (const auto& [n, t]: _tables)
        tables[i++] = n;
    nlohmann::json config_json{{"tables", std::move(tables)}};
    std::ofstream config_file(_storage_location + "/config.json");
    config_file << config_json.dump();
}

void Database::create_table(std::string_view table_name, const Table::ColumnInfos& column_infos) {
    const std::string table_name_s(table_name);
    if (_tables.contains(table_name_s)){
        if (column_infos != _tables.at(table_name_s)->column_infos)
            throw std::runtime_error(log_msg("A table with the same name and different columns already exists"));
    }
    else {
        _tables[table_name_s] = std::make_unique<Table>(_storage_location + '/' + table_name_s, std::optional<Table::ColumnInfos>{column_infos});
    }
}

const std::vector<Database::ColumnType>& Database::get_table_data(std::string_view table) {
    const std::string table_s(table);
    if (!_tables.contains(table_s))
        throw std::runtime_error(log_msg("The table from which the data should be returned does not exist"));
    return _tables.at(table_s)->loaded_data;
}